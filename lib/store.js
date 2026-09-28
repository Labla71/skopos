// Thin storage layer over node:sqlite (still experimental in Node 22). No other module knows
// SQL; if the API changes, only this file needs to change.
// Own database: journal mode DELETE (no WAL), file mode 0644 — another user can open it
// read-only without write access to the directory.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_DB_PATH = '/var/lib/skopos/skopos.db';
export const SCHEMA_VERSION = 1;
// A run (timer) and a report (pulled over SSH) can meet; instead of failing at once with
// "database is locked", the other side waits up to this limit.
export const BUSY_TIMEOUT_MS = 10000;
const DAY_MS = 24 * 3600 * 1000;
const STATUSES = ['ok', 'warn', 'crit', 'unknown'];

const SCHEMA = `
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  count_ok INTEGER NOT NULL,
  count_warn INTEGER NOT NULL,
  count_crit INTEGER NOT NULL,
  count_unknown INTEGER NOT NULL,
  version TEXT NOT NULL,
  interval_minutes INTEGER
);
CREATE TABLE measurements (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  time TEXT NOT NULL,
  "check" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value",
  unit TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','warn','crit','unknown')),
  reason TEXT
);
CREATE INDEX measurements_run ON measurements(run_id);
CREATE INDEX measurements_time ON measurements(time);
CREATE TABLE state (
  "check" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  PRIMARY KEY ("check", "key")
);
`;

// Step-by-step migrations, indexed by the version they start from. None yet.
const MIGRATIONS = {};

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function checkSchema(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v > SCHEMA_VERSION) throw new Error(`database has schema version ${v}, this code only knows ${SCHEMA_VERSION}`);
  return v;
}

// Open for writing; creates the file and schema if missing and migrates older versions.
export function openStore(path) {
  const isNew = !existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = DELETE');
    const v = checkSchema(db);
    if (v < SCHEMA_VERSION) {
      transaction(db, () => {
        if (v === 0) db.exec(SCHEMA);
        else for (let i = v; i < SCHEMA_VERSION; i += 1) db.exec(MIGRATIONS[i]);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    if (isNew) chmodSync(path, 0o644);
  } catch (e) {
    db.close();
    throw e;
  }
  return build(db);
}

// Open read-only (report). A missing file is an error, not an empty database.
export function openStoreReadOnly(path) {
  if (!existsSync(path)) throw new Error(`database ${path} does not exist (Skopos has never run here?)`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const v = checkSchema(db);
    if (v === 0) throw new Error(`${path} contains no Skopos schema`);
    if (v < SCHEMA_VERSION) throw new Error(`${path} has schema version ${v}; a run (skopos run) migrates it to ${SCHEMA_VERSION} first`);
  } catch (e) {
    db.close();
    throw e;
  }
  return build(db);
}

function build(db) {
  const q = (sql) => db.prepare(sql);
  const putState = (check, key, value) => q(
    `INSERT INTO state ("check", "key", "value") VALUES (?, ?, ?)
     ON CONFLICT ("check", "key") DO UPDATE SET "value" = excluded."value"`,
  ).run(check, key, JSON.stringify(value));

  return {
    close: () => db.close(),

    getState(check, key) {
      const row = q('SELECT "value" FROM state WHERE "check" = ? AND "key" = ?').get(check, key);
      return row ? JSON.parse(row.value) : undefined;
    },

    // Writes a complete run atomically: heartbeat, measurements, state changes.
    saveRun({ startedAt, finishedAt, version, intervalMinutes = null, measurements, state }) {
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const m of measurements) counts[m.status] += 1;
      return transaction(db, () => {
        const { lastInsertRowid: runId } = q(
          `INSERT INTO runs (started_at, finished_at, duration_ms, count_ok, count_warn, count_crit, count_unknown, version, interval_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(startedAt, finishedAt, Date.parse(finishedAt) - Date.parse(startedAt), counts.ok, counts.warn, counts.crit, counts.unknown, version, intervalMinutes);
        const insert = q(
          `INSERT INTO measurements (run_id, time, "check", "key", "value", unit, status, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const m of measurements) {
          insert.run(runId, m.time, m.check, m.key, m.value, m.unit ?? null, m.status, m.reason ?? null);
        }
        for (const s of state) putState(s.check, s.key, s.value);
        return Number(runId);
      });
    },

    // Deletes runs (and, by cascade, their measurements) before `cutoff` (ISO timestamp).
    prune(cutoff) {
      return transaction(db, () => {
        q('DELETE FROM measurements WHERE time < ?').run(cutoff);
        return Number(q('DELETE FROM runs WHERE started_at < ?').run(cutoff).changes);
      });
    },

    // Prunes at most once every 24 hours; the timestamp lives in the core's own state.
    pruneIfDue(retentionDays, now) {
      const last = this.getState('skopos', 'last_prune');
      if (last !== undefined && now.getTime() - Date.parse(last) < DAY_MS) return null;
      const deleted = this.prune(new Date(now.getTime() - retentionDays * DAY_MS).toISOString());
      putState('skopos', 'last_prune', now.toISOString());
      return deleted;
    },

    lastRun: () => q('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() ?? null,
    measurementsOfRun: (runId) => q('SELECT * FROM measurements WHERE run_id = ? ORDER BY id').all(runId),
    history: (since) => q('SELECT * FROM measurements WHERE time >= ? ORDER BY time, id').all(since),
    countRuns: (since) => q('SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?').get(since).n,
  };
}
