import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ConfigError, loadConfig, validateConfig } from '../lib/config.js';
import { normalize, runOnce } from '../lib/run.js';
import { buildReport } from '../lib/report.js';
import { SCHEMA_VERSION, openStore, openStoreReadOnly } from '../lib/store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'skopos.js');

function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), 'skopos-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// Test checks, in the same registry shape as lib/checks/index.js.
const testChecks = {
  fixed: { name: 'fixed', required: [], optional: [], measure: async () => [{ value: 1, unit: 'x', status: 'ok' }] },
  throws: { name: 'throws', required: [], optional: [], measure: async () => { throw new Error('broken'); } },
  throwsSync: { name: 'throwsSync', required: [], optional: [], measure: () => { throw new Error('at once'); } },
  hangs: { name: 'hangs', required: [], optional: [], measure: () => new Promise(() => {}) },
  counter: {
    name: 'counter', required: [], optional: [],
    measure: async (_p, ctx) => {
      const old = ctx.state.get('n') ?? 0;
      ctx.state.set('n', old + 1);
      return [{ value: old + 1, status: 'ok' }];
    },
  },
  counterThrows: {
    name: 'counterThrows', required: [], optional: [],
    measure: async (_p, ctx) => { ctx.state.set('n', 99); throw new Error('after set'); },
  },
  several: {
    name: 'several', required: ['limit'], optional: [],
    measure: async () => [{ key: 'a', value: 1, status: 'ok' }, { key: 'b', value: 2, status: 'crit', reason: 'too high' }],
  },
};
const cfg = (...checks) => validateConfig({ timeout_seconds: 0.05, checks: checks.map((c, i) => ({ check: c, key: `k${i}`, ...(c === 'several' ? { limit: 1 } : {}) })) }, testChecks);
const rowsOfLastRun = (store) => store.measurementsOfRun(store.lastRun().id);
const opts = (extra = {}) => ({ checks: testChecks, version: 't', ...extra });

test('a throwing check (async and sync) becomes unknown with a reason, other checks keep running', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  await runOnce(cfg('throws', 'fixed', 'throwsSync'), s, opts());
  const [a, b, c] = rowsOfLastRun(s);
  assert.equal(a.status, 'unknown');
  assert.equal(a.value, null);
  assert.match(a.reason, /broken/);
  assert.equal(b.status, 'ok');
  assert.equal(c.status, 'unknown');
  assert.match(c.reason, /at once/);
});

test('a check timeout becomes unknown, later checks still run', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  await runOnce(cfg('hangs', 'fixed'), s, opts());
  const [a, b] = rowsOfLastRun(s);
  assert.equal(a.status, 'unknown');
  assert.match(a.reason, /timeout/);
  assert.equal(b.status, 'ok');
});

test('heartbeat: start, end, duration, counts per status, version, interval', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  await runOnce(cfg('fixed', 'throws', 'several'), s, opts({ version: '9.9' }));
  const r = s.lastRun();
  assert.deepEqual([r.count_ok, r.count_warn, r.count_crit, r.count_unknown], [2, 0, 1, 1]);
  assert.equal(r.version, '9.9');
  assert.equal(r.interval_minutes, 5);
  assert.ok(Date.parse(r.finished_at) >= Date.parse(r.started_at));
  assert.equal(r.duration_ms, Date.parse(r.finished_at) - Date.parse(r.started_at));
});

test('several measurements of one check get sub-keys', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  await runOnce(cfg('several'), s, opts());
  assert.deepEqual(rowsOfLastRun(s).map((m) => m.key), ['k0.a', 'k0.b']);
});

test('invalid results become unknown, never an invented value', () => {
  const e = { check: 'x', key: 'k' };
  const time = '2026-01-01T00:00:00.000Z';
  for (const raw of [null, 'text', { status: 'good', value: 1 }, { status: 'ok', value: NaN }, { status: 'ok' }, { status: 'ok', value: true }, { key: { bad: 1 }, value: 1, status: 'ok' }, []]) {
    const [r] = normalize(e, raw, time);
    assert.equal(r.status, 'unknown', JSON.stringify(raw));
    assert.equal(r.value, null);
    assert.ok(r.reason);
  }
  assert.equal(normalize(e, { status: 'unknown' }, time)[0].reason, 'unknown reported without a reason');
});

test('state only advances after a successful check', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  const c = cfg('counter');
  await runOnce(c, s, opts());
  await runOnce(c, s, opts());
  assert.equal(rowsOfLastRun(s)[0].value, 2);
  await runOnce(cfg('counterThrows'), s, opts());
  assert.equal(s.getState('counterThrows', 'k0/n'), undefined);
});

test('an invalid state value makes only that check unknown, the run survives', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  const checks = {
    ...testChecks,
    undef: { name: 'undef', required: [], optional: [], measure: async (_p, ctx) => { ctx.state.set('x', undefined); return [{ value: 1, status: 'ok' }]; } },
    cycle: { name: 'cycle', required: [], optional: [], measure: async (_p, ctx) => { const o = {}; o.o = o; ctx.state.set('x', o); return [{ value: 1, status: 'ok' }]; } },
    badKey: { name: 'badKey', required: [], optional: [], measure: async (_p, ctx) => { ctx.state.set('a/b', 1); return [{ value: 1, status: 'ok' }]; } },
  };
  const c = validateConfig({ checks: ['undef', 'cycle', 'badKey', 'fixed'].map((n) => ({ check: n, key: 'k' })) }, checks);
  const r = await runOnce(c, s, { checks, version: 't' });
  assert.ok(r.runId >= 1, 'heartbeat written');
  const rows = rowsOfLastRun(s);
  assert.deepEqual(rows.map((m) => m.status), ['unknown', 'unknown', 'unknown', 'ok']);
  assert.match(rows[0].reason, /JSON/);
  assert.match(rows[1].reason, /JSON/);
  assert.match(rows[2].reason, /state key/);
  assert.equal(s.getState('undef', 'k/x'), undefined);
});

test('config: missing, broken and incomplete files abort loudly', (t) => {
  const d = tmp(t);
  assert.throws(() => loadConfig(join(d, 'does-not-exist.json'), testChecks), ConfigError);
  writeFileSync(join(d, 'broken.json'), '{ not json');
  assert.throws(() => loadConfig(join(d, 'broken.json'), testChecks), /not valid JSON/);
});

test('config: strict validation collects all errors', () => {
  const check = (raw) => { try { validateConfig(raw, testChecks); } catch (e) { return e.messages.join('\n'); } assert.fail('did not abort'); };
  assert.match(check([]), /JSON object/);
  assert.match(check({}), /checks is missing/);
  assert.match(check({ checks: [] }), /checks is missing/);
  assert.match(check({ checks: [{ check: 'x', key: 'a' }] }), /unknown check/);
  assert.match(check({ checks: [{ check: 'fixed' }] }), /key is missing/);
  assert.match(check({ checks: [{ check: 'fixed', key: 'a.b' }] }), /key/);
  assert.match(check({ checks: [{ check: 'several', key: 'a' }] }), /required value "limit" is missing/);
  assert.match(check({ checks: [{ check: 'fixed', key: 'a', extra: 1 }] }), /unknown key "extra"/);
  assert.match(check({ checks: [{ check: 'fixed', key: 'a' }, { check: 'fixed', key: 'a' }] }), /twice/);
  const all = check({ retention_days: 0, interval_minutes: 'x', timeout_seconds: -1, checks: [{ check: 'fixed', key: 'a' }], additional: 1 });
  for (const part of ['retention_days', 'interval_minutes', 'timeout_seconds', 'unknown key "additional"']) assert.ok(all.includes(part), part);
  const ok = validateConfig({ _comment: 'x', checks: [{ _comment: 'y', check: 'fixed', key: 'a' }] }, testChecks);
  assert.deepEqual([ok.interval_minutes, ok.retention_days, ok.timeout_seconds], [5, 30, 30]);
});

test('config: names from the Object prototype are not checks', () => {
  for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    assert.throws(() => validateConfig({ checks: [{ check: name, key: 'x' }] }), (e) => e instanceof ConfigError && /unknown check/.test(e.message), name);
  }
});

test('config: every example in the repo is valid', () => {
  // Collector examples (example-collect*.json) have their own schema, checked in collect.test.js.
  const examples = readdirSync(join(root, 'config')).filter((f) => /^example.*\.json$/.test(f) && !f.startsWith('example-collect'));
  assert.ok(examples.length >= 1);
  for (const f of examples) loadConfig(join(root, 'config', f));
});

test('retention deletes old data, keeps new data; prunes at most once every 24 h', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  const c = cfg('fixed');
  const day = (n) => new Date(Date.UTC(2026, 0, n));
  for (const n of [1, 2, 20]) {
    // Long retention so that pruning during these runs does not delete them early.
    await runOnce({ ...c, retention_days: 1000 }, s, opts({ now: () => day(n) }));
  }
  assert.equal(s.countRuns('0000'), 3);
  // The last prune ran on 20 January: twelve hours later it is not due.
  assert.equal(s.pruneIfDue(5, new Date(day(20).getTime() + 12 * 3600 * 1000)), null);
  // 5 days of retention on 25 January: cutoff 20 January → days 1 and 2 go, day 20 stays.
  assert.equal(s.pruneIfDue(5, day(25)), 2);
  assert.equal(s.countRuns('0000'), 1);
  assert.equal(s.history('0000').length, 1, 'measurements of deleted runs are gone');
  assert.equal(s.pruneIfDue(5, day(25)), null, 'not again right after');
});

test('store: DELETE journal, mode 0644, reopening keeps data, read-only handle does not write', async (t) => {
  const d = tmp(t);
  const path = join(d, 'sub', 'a.db');
  const s = openStore(path);
  await runOnce(cfg('fixed'), s, opts());
  s.close();
  assert.equal(statSync(path).mode & 0o777, 0o644);
  const s2 = openStore(path);
  assert.equal(s2.countRuns('0000'), 1);
  s2.close();
  const r = openStoreReadOnly(path);
  t.after(() => r.close());
  assert.equal(r.countRuns('0000'), 1);
  assert.throws(() => r.prune('9999'));
  assert.throws(() => openStoreReadOnly(join(d, 'missing.db')), /does not exist/);
});

test('store: a newer schema version or a foreign database is refused, not overwritten', (t) => {
  const d = tmp(t);
  const newer = join(d, 'newer.db');
  const db = new DatabaseSync(newer);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => openStore(newer), /schema version/);
  assert.throws(() => openStoreReadOnly(newer), /schema version/);
  const foreign = join(d, 'foreign.db');
  new DatabaseSync(foreign).close();
  assert.throws(() => openStoreReadOnly(foreign), /no Skopos schema/);
});

test('report: heartbeat, current status per check, history in the window', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  await runOnce(cfg('fixed'), s, opts({ now: () => new Date('2026-01-01T00:00:00Z') }));
  await runOnce(cfg('fixed', 'throws'), s, opts({ now: () => new Date('2026-01-02T00:00:00Z') }));
  const r = buildReport(s, { now: new Date('2026-01-02T00:10:00Z') });
  assert.equal(r.heartbeat.age_seconds, 600);
  assert.deepEqual(r.heartbeat.counts, { ok: 1, warn: 0, crit: 0, unknown: 1 });
  assert.equal(r.heartbeat.runs_in_window, 1, 'default: last 24 h');
  assert.deepEqual(r.checks.map((c) => [c.check, c.key, c.status]), [['fixed', 'k0', 'ok'], ['throws', 'k1', 'unknown']]);
  assert.deepEqual(Object.keys(r.checks[1]).sort(), ['check', 'key', 'reason', 'status', 'time', 'unit', 'value']);
  const all = buildReport(s, { since: '2026-01-01T00:00:00.000Z', now: new Date('2026-01-02T00:10:00Z') });
  assert.equal(all.history.length, 3);
  assert.equal(all.heartbeat.runs_in_window, 2);
});

test('report: the heartbeat carries the interval, the report computes "stale" itself', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  const c = validateConfig({ interval_minutes: 5, checks: [{ check: 'fixed', key: 'k' }] }, testChecks);
  await runOnce(c, s, opts({ now: () => new Date('2026-01-01T00:00:00Z') }));
  const fresh = buildReport(s, { now: new Date('2026-01-01T00:10:00Z') }).heartbeat;
  assert.equal(fresh.interval_minutes, 5);
  assert.equal(fresh.stale, false, '600 s = exactly two intervals, not stale yet');
  assert.equal(buildReport(s, { now: new Date('2026-01-01T00:10:01Z') }).heartbeat.stale, true);
});

test('report: a run without a known interval is "stale: null", not "ok"', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  s.saveRun({ startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', version: 't', measurements: [], state: [] });
  const hb = buildReport(s, { now: new Date('2026-01-01T01:00:00Z') }).heartbeat;
  assert.equal(hb.interval_minutes, null);
  assert.equal(hb.stale, null);
});

test('report without runs: heartbeat is null, not invented', async (t) => {
  const s = openStore(join(tmp(t), 'a.db'));
  t.after(() => s.close());
  const r = buildReport(s);
  assert.equal(r.heartbeat, null);
  assert.deepEqual(r.checks, []);
});

// Holds a lock on the database in a second process (like a concurrent report or run) and
// releases it after `ms`. A second process is required: node:sqlite waits synchronously, so
// within one process the release would never get its turn.
function holdLock(path, kind, ms) {
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const [path, kind, ms] = process.argv.slice(1);
    const db = new DatabaseSync(path, kind === 'read' ? { readOnly: true } : {});
    if (kind === 'read') { db.exec('BEGIN'); db.prepare('SELECT COUNT(*) FROM runs').get(); }
    else db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('ready\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
    db.exec('COMMIT');
    db.close();`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, path, kind, String(ms)]);
  const ready = new Promise((ok, fail) => {
    child.stdout.on('data', (d) => d.toString().includes('ready') && ok());
    child.on('exit', (code) => fail(new Error(`lock process ended early (${code})`)));
  });
  const done = new Promise((ok) => child.on('exit', ok));
  return { ready, done };
}

test('a run waits for a concurrent reader instead of failing with "database is locked"', async (t) => {
  const path = join(tmp(t), 'a.db');
  const s = openStore(path);
  t.after(() => s.close());
  await runOnce(cfg('fixed'), s, opts());
  const lock = holdLock(path, 'read', 300);
  await lock.ready;
  await runOnce(cfg('fixed'), s, opts());
  assert.equal(s.countRuns('0000'), 2);
  await lock.done;
});

test('a report waits for a concurrent writer', async (t) => {
  const path = join(tmp(t), 'a.db');
  const s = openStore(path);
  await runOnce(cfg('fixed'), s, opts());
  s.close();
  const lock = holdLock(path, 'write', 300);
  await lock.ready;
  const r = openStoreReadOnly(path);
  t.after(() => r.close());
  assert.equal(buildReport(r).heartbeat.run_id, 1);
  await lock.done;
});

const node = (args, env = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('CLI: run writes heartbeat and measurements, report --json returns valid JSON', (t) => {
  const d = tmp(t);
  const db = join(d, 'skopos.db');
  const config = join(d, 'config.json');
  writeFileSync(config, JSON.stringify({ checks: [{ check: 'uptime', key: 'boot' }] }));
  const run = node(['run', '--config', config, '--db', db]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^run 1: ok=1 warn=0 crit=0 unknown=0 \(\d+ ms, peak rss \d+\.\d MB\)$/m);
  assert.equal(run.stderr, '', 'no ExperimentalWarning');
  const rep = node(['report', '--json', '--since', '2000-01-01T00:00:00Z'], { SKOPOS_DB: db });
  assert.equal(rep.status, 0, rep.stderr);
  const r = JSON.parse(rep.stdout);
  assert.equal(r.heartbeat.counts.ok, 1);
  assert.equal(r.since, '2000-01-01T00:00:00.000Z');
  assert.equal(r.checks[0].check, 'uptime');
  assert.equal(r.checks[0].unit, 's');
  assert.ok(r.checks[0].value > 0);
});

test('CLI: errors abort loudly (config, database, arguments)', (t) => {
  const d = tmp(t);
  const db = join(d, 'skopos.db');
  const bad = join(d, 'bad.json');
  writeFileSync(bad, JSON.stringify({ checks: [{ check: 'nosuchcheck', key: 'a' }] }));
  const a = node(['run', '--config', bad, '--db', db]);
  assert.equal(a.status, 2);
  assert.match(a.stderr, /unknown check/);
  assert.equal(node(['run', '--config', join(d, 'missing.json'), '--db', db]).status, 2);
  const b = node(['report', '--json', '--db', join(d, 'nothing.db')]);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /does not exist/);
  assert.equal(node(['report', '--json', '--since', 'yesterday', '--db', db]).status, 2);
  assert.equal(node(['report', 'extra', '--db', db]).status, 2);
  assert.equal(node([]).status, 2);
});

test('the core contains no network access', () => {
  // Looks for real network APIs instead of word fragments, so an English comment
  // mentioning a "network" does not trip it.
  const pattern = /node:(?:net|http|https|http2|dgram|tls|dns)\b|\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/;
  const files = (dir) => readdirSync(join(root, dir), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => join(dir, f));
  const hits = [...files('lib'), ...files('bin')].filter((f) => pattern.test(readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(hits, []);
  assert.ok(pattern.test("import x from 'node:https'"), 'the pattern itself works');
});

test('CLI: called directly (as systemd and the collector do), it prints no ExperimentalWarning', (t) => {
  // The flag in the shebang only applies when the script itself is executed; with
  // "node bin/skopos.js" the warning may appear, depending on how long the run takes.
  const d = tmp(t);
  const config = join(d, 'config.json');
  writeFileSync(config, JSON.stringify({ checks: [{ check: 'uptime', key: 'a' }, { check: 'memory', key: 'm' }, { check: 'load', key: 'l' }] }));
  const run = spawnSync(cli, ['run', '--config', config, '--db', join(d, 's.db')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const rep = spawnSync(cli, ['report', '--json', '--db', join(d, 's.db')], { encoding: 'utf8' });
  assert.equal(rep.status, 0, rep.stderr);
  assert.equal(rep.stderr, '');
});

test('CLI: a report larger than the 64 KB pipe buffer arrives complete through a slow pipe', async (t) => {
  // process.exit() used to cut the output at 65,536 bytes when stdout was a pipe (as over SSH).
  const d = tmp(t);
  const db = join(d, 'big.db');
  const s = openStore(db);
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 60; i += 1) {
    const time = new Date(t0 + i * 300000).toISOString();
    s.saveRun({ startedAt: time, finishedAt: time, version: 't', intervalMinutes: 5, state: [],
      measurements: Array.from({ length: 26 }, (_, k) => ({ time, check: 'c', key: `k${k}`, value: k, unit: 'x', status: 'ok', reason: null })) });
  }
  s.close();
  const child = spawn(cli, ['report', '--json', '--since', '2000-01-01T00:00:00Z', '--db', db]);
  const closed = new Promise((r) => child.on('close', r));
  const chunks = [];
  // Slow reader: consume nothing for a moment, so the 64 KB pipe buffer fills up.
  child.stdout.pause();
  child.stdout.on('data', (c) => chunks.push(c));
  await new Promise((r) => setTimeout(r, 300));
  child.stdout.resume();
  const code = await closed;
  const text = Buffer.concat(chunks).toString('utf8');
  assert.equal(code, 0);
  assert.ok(text.length > 65536, `report is only ${text.length} bytes, the test needs more than 64 KB`);
  assert.equal(JSON.parse(text).history.length, 60 * 26);
});
