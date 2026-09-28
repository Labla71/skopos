import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateConfig } from '../lib/config.js';
import { CHECKS } from '../lib/checks/index.js';
import check from '../lib/checks/sqlite-query.js';
import { checkQuery, openReadOnly, ReadError, withReadOnly } from '../lib/sqlite-read.js';

const dir = mkdtempSync(join(tmpdir(), 'skopos-sq-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const isRoot = process.getuid?.() === 0;

// A database in rollback-journal mode (no -wal file), with the given statements applied.
function makeDb(...statements) {
  const path = join(dir, `db-${(counter += 1)}.sqlite`);
  const db = new DatabaseSync(path);
  for (const s of statements) db.exec(s);
  db.close();
  return path;
}
const ITEMS = ['CREATE TABLE items (name TEXT, qty INTEGER, note TEXT)', "INSERT INTO items VALUES ('a', 5, 'x'), ('b', 7, NULL)"];
const sum = (extra = {}) => ({ query: 'SELECT SUM(qty) FROM items', ...extra });
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const newState = () => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
};
const measure = (params, ctx = { state: newState() }) => check.measure(params, ctx);
const one = async (params, ctx) => {
  const r = await measure(params, ctx);
  assert.equal(r.length, 1);
  return r[0];
};

// ---------- value and thresholds ----------
test('value: a number is stored as measured, thresholds rate it (at or above / at or below)', async () => {
  const database = makeDb(...ITEMS);
  let r = await one({ database, ...sum({ unit: 'pcs' }) });
  assert.deepEqual(r, { value: 12, status: 'ok', unit: 'pcs' });
  assert.equal((await one({ database, ...sum({ warn_above: 12 }) })).status, 'warn');
  assert.equal((await one({ database, ...sum({ warn_above: 5, crit_above: 12 }) })).status, 'crit');
  assert.equal((await one({ database, ...sum({ warn_above: 13 }) })).status, 'ok');
  assert.equal((await one({ database, ...sum({ warn_below: 12 }) })).status, 'warn');
  assert.equal((await one({ database, ...sum({ warn_below: 20, crit_below: 12 }) })).status, 'crit');
  assert.equal((await one({ database, ...sum({ warn_below: 11 }) })).status, 'ok');
  r = await one({ database, ...sum({ warn_above: 5, crit_below: 20 }) });
  assert.equal(r.status, 'crit', 'the worse of the two directions wins');
});

test('value: a column can be picked from a wider row, a wrong column is unknown', async () => {
  const database = makeDb(...ITEMS);
  const q = { database, query: 'SELECT SUM(qty) AS total, COUNT(*) AS n FROM items' };
  let r = await one({ ...q, column: 'n' });
  assert.equal(r.value, 2);
  r = await one(q);
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /2 columns.*"column"/);
  r = await one({ ...q, column: 'missing' });
  assert.match(r.reason, /column "missing" is not in the query result/);
});

// ---------- result shape ----------
test('shape: no row, several rows, text, blob and NULL are unknown, never a zero', async () => {
  const database = makeDb(...ITEMS);
  const cases = [
    ['SELECT qty FROM items WHERE 0', /no row/],
    ['SELECT qty FROM items', /more than one row/],
    ['SELECT name FROM items LIMIT 1', /text, expected a number/],
    ['SELECT x\'00\' ', /not a number/],
    ['SELECT note FROM items WHERE name = \'b\'', /NULL/],
    ['SELECT SUM(qty) FROM items WHERE 0', /NULL/],
  ];
  for (const [query, reason] of cases) {
    const r = await one({ database, query });
    assert.equal(r.status, 'unknown', query);
    assert.equal(r.value, undefined, query);
    assert.match(r.reason, reason, query);
  }
});

test('shape: null_as is explicit; without it NULL stays unknown', async () => {
  const database = makeDb(...ITEMS);
  const r = await one({ database, query: 'SELECT SUM(qty) FROM items WHERE 0', null_as: 0 });
  assert.equal(r.value, 0);
  assert.equal(r.status, 'ok');
  assert.match(r.reason, /NULL counted as 0/);
  // a real value is not touched by null_as
  assert.equal((await one({ database, ...sum({ null_as: 0 }) })).value, 12);
});

// ---------- cannot measure ----------
test('missing table or column is unknown with the reason from SQLite', async () => {
  const database = makeDb(...ITEMS);
  let r = await one({ database, query: 'SELECT SUM(missing_column) FROM items' });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /query failed: .*missing_column/);
  r = await one({ database, query: 'SELECT 1 FROM missing_table' });
  assert.match(r.reason, /query failed: .*missing_table/);
});

test('missing file, directory and a file that is no database are unknown', async () => {
  let r = await one({ database: join(dir, 'nope.sqlite'), ...sum() });
  assert.deepEqual([r.status, r.reason], ['unknown', 'database file not found']);
  r = await one({ database: dir, ...sum() });
  assert.match(r.reason, /not a regular file/);
  const junk = join(dir, 'junk.sqlite');
  writeFileSync(junk, 'this is not a database, just text that is long enough to look like a header');
  r = await one({ database: junk, ...sum() });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /query failed/);
});

test('no read permission is unknown with that reason, not a zero', { skip: isRoot && 'root ignores file modes' }, async () => {
  const database = makeDb(...ITEMS);
  chmodSync(database, 0o000);
  try {
    const r = await one({ database, ...sum() });
    assert.equal(r.status, 'unknown');
    assert.equal(r.value, undefined);
    assert.match(r.reason, /no read permission/);
  } finally {
    chmodSync(database, 0o644);
  }
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  const inside = join(locked, 'db.sqlite');
  new DatabaseSync(inside).close();
  chmodSync(locked, 0o000);
  try {
    const r = await one({ database: inside, ...sum() });
    assert.match(r.reason, /no read permission/);
  } finally {
    chmodSync(locked, 0o755);
  }
});

// ---------- read-only guarantee ----------
test('writes are refused and the database file stays byte-identical', async () => {
  const database = makeDb(...ITEMS);
  const before = digest(database);
  const attempts = [
    'DELETE FROM items',
    'UPDATE items SET qty = 0',
    'INSERT INTO items VALUES (\'c\', 1, NULL)',
    'DROP TABLE items',
    'SELECT 1; DELETE FROM items',
    'SELECT 1; SELECT 2',
    'SELECT 1;;DELETE FROM items',
    'PRAGMA journal_mode = WAL',
    'ATTACH DATABASE \'/nonexistent/x.db\' AS x',
    '/* SELECT */ DELETE FROM items',
    '-- SELECT\nDELETE FROM items',
  ];
  for (const query of attempts) {
    const r = await one({ database, query });
    assert.equal(r.status, 'unknown', query);
    assert.equal(digest(database), before, query);
  }
  assert.equal(existsSync(`${database}-wal`), false);
  assert.equal(existsSync(`${database}-journal`), false);
});

test('a WITH statement that writes passes the text check but the connection refuses it', async () => {
  const database = makeDb(...ITEMS);
  const before = digest(database);
  const query = 'WITH x AS (SELECT 1) DELETE FROM items';
  assert.equal(checkQuery(query), undefined, 'the text check alone cannot know this');
  const r = await one({ database, query });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /query failed: .*read/i);
  assert.equal(digest(database), before);
  assert.equal((await one({ database, ...sum() })).value, 12, 'the rows are still there');
});

test('checkQuery: one SELECT/WITH statement, quotes and comments are respected', () => {
  for (const ok of [
    'SELECT 1',
    '  select 1  ;  ',
    'SELECT 1; -- done',
    "SELECT ';' AS semi",
    'SELECT "a;b" FROM t',
    "SELECT 'it''s; fine'",
    'SELECT [a;b] FROM t',
    'SELECT 1 /* ; */',
    '-- lead\nSELECT 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
  ]) assert.equal(checkQuery(ok), undefined, ok);
  for (const bad of ['', '   ', ';', '-- only a comment', 'DELETE FROM t', 'SELECT 1; SELECT 2', "SELECT 'open", 'SELECT 1 /* open', 'UPDATE t SET a = 1', 42, undefined]) {
    assert.equal(typeof checkQuery(bad), 'string', String(bad));
  }
});

// ---------- delta (counter since the last run) ----------
test('delta: baseline, increase, no change, and a reset is not a negative value', async () => {
  const database = makeDb('CREATE TABLE hits (n INTEGER)', 'INSERT INTO hits VALUES (5)');
  const ctx = { state: newState() };
  const setTo = (n) => {
    const db = new DatabaseSync(database);
    db.exec(`UPDATE hits SET n = ${n}`);
    db.close();
  };
  const params = { database, query: 'SELECT n FROM hits', delta: true, on_decrease: 'restart', warn_above: 1, crit_above: 10 };
  let r = await one(params, ctx);
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /no baseline yet/);
  setTo(8);
  r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [3, 'warn']);
  r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [0, 'ok']);
  setTo(30);
  r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [22, 'crit']);
  // new day / new database: the counter falls to 2 — 2 is counted, nothing negative
  setTo(2);
  r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [2, 'warn']);
  assert.match(r.reason, /counter reset \(was 30, now 2\)/);
  r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [0, 'ok']);
  assert.equal(r.reason, undefined);
});

test('delta over a day change with a NULL sum: null_as 0 makes the empty day a reset to 0', async () => {
  const database = makeDb('CREATE TABLE hits (day TEXT, n INTEGER)', "INSERT INTO hits VALUES ('d1', 4)");
  const ctx = { state: newState() };
  const params = { database, query: "SELECT SUM(n) FROM hits WHERE day = (SELECT day FROM cur)", delta: true, on_decrease: 'restart', null_as: 0, warn_above: 1 };
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE cur (day TEXT); INSERT INTO cur VALUES ('d1')");
  db.close();
  const move = (sql) => {
    const d = new DatabaseSync(database);
    d.exec(sql);
    d.close();
  };
  await one(params, ctx); // baseline 4
  move("INSERT INTO hits VALUES ('d1', 3)"); // 7
  let r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [3, 'warn']);
  move("UPDATE cur SET day = 'd2'"); // new day, no rows yet -> NULL -> 0
  r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [0, 'ok']);
  assert.match(r.reason, /NULL counted as 0.*counter reset/);
  move("INSERT INTO hits VALUES ('d2', 2)");
  r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [2, 'warn']);
});

test('delta: an unreadable database leaves the watermark where it was', async () => {
  const database = makeDb('CREATE TABLE hits (n INTEGER)', 'INSERT INTO hits VALUES (5)');
  const ctx = { state: newState() };
  const params = { database, query: 'SELECT n FROM hits', delta: true, on_decrease: 'restart' };
  await one(params, ctx);
  const bad = await one({ ...params, database: join(dir, 'gone.sqlite') }, ctx);
  assert.equal(bad.status, 'unknown');
  assert.equal(ctx.state.get('last'), 5);
  const db = new DatabaseSync(database);
  db.exec('UPDATE hits SET n = 9');
  db.close();
  assert.equal((await one(params, ctx)).value, 4, 'counted from the last successful reading');
});

test('delta with on_decrease "rebase": a fall (deleted or restored rows) is a new baseline, never a spike', async () => {
  const database = makeDb('CREATE TABLE hits (n INTEGER)', 'INSERT INTO hits VALUES (500)');
  const ctx = { state: newState() };
  const setTo = (n) => {
    const db = new DatabaseSync(database);
    db.exec(`UPDATE hits SET n = ${n}`);
    db.close();
  };
  const params = { database, query: 'SELECT n FROM hits', delta: true, on_decrease: 'rebase', warn_above: 1, crit_above: 10 };
  await one(params, ctx); // baseline 500
  setTo(503);
  let r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [3, 'warn']);
  setTo(490); // old rows pruned: with "restart" this would be 490 new errors and crit
  r = await one(params, ctx);
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /decreased \(was 503, now 490\).*new baseline/);
  assert.equal(ctx.state.get('last'), 490);
  setTo(492);
  r = await one(params, ctx);
  assert.deepEqual([r.value, r.status], [2, 'warn'], 'counting continues from the new baseline');
});

// ---------- opening strategy (decision 5) ----------
test('open: without -wal the immutable branch is used and reads the exact content', () => {
  const database = makeDb(...ITEMS);
  const { db, mode } = openReadOnly(database);
  try {
    assert.equal(mode, 'immutable');
    assert.equal(db.prepare('SELECT SUM(qty) AS s FROM items').get().s, 12);
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000, 'foreign connections get a busy timeout too');
  } finally {
    db.close();
  }
});

test('open: with -wal (a second process keeps the database open in WAL mode) the readOnly branch sees WAL-only rows', async () => {
  const database = join(dir, 'wal.sqlite');
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    db.exec('CREATE TABLE items (qty INTEGER); INSERT INTO items VALUES (5)');
    db.exec('INSERT INTO items VALUES (7)');
    console.log('ready');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script, database], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise((resolve) => child.on('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('ready') && resolve());
      child.on('error', reject);
      child.on('close', () => reject(new Error('holder process ended early')));
    });
    assert.equal(existsSync(`${database}-wal`), true);
    const { db, mode } = openReadOnly(database);
    try {
      assert.equal(mode, 'readonly');
      assert.equal(db.prepare('SELECT SUM(qty) AS s FROM items').get().s, 12);
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    } finally {
      db.close();
    }
    const r = await one({ database, query: 'SELECT SUM(qty) FROM items' });
    assert.deepEqual([r.value, r.status], [12, 'ok']);
    const before = digest(database);
    const w = await one({ database, query: 'DELETE FROM items' });
    assert.equal(w.status, 'unknown');
    assert.equal(digest(database), before);
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
});

test('immutable read: a file that changes while it is read is retried once, then reported', () => {
  const database = makeDb(...ITEMS);
  const touch = (n) => utimesSync(database, new Date(), new Date(Date.now() + n * 10000));
  let calls = 0;
  const first = withReadOnly(database, (db) => {
    calls += 1;
    if (calls === 1) touch(1); // the file moved during the first read
    return db.prepare('SELECT SUM(qty) AS s FROM items').get().s;
  });
  assert.deepEqual([first.result, first.mode, calls], [12, 'immutable', 2]);
  calls = 0;
  assert.throws(
    () => withReadOnly(database, () => {
      calls += 1;
      touch(calls + 1);
      return 1;
    }),
    (e) => e instanceof ReadError && /changed while it was being read/.test(e.message),
  );
  assert.equal(calls, 2);
});

test('immutable read: an error from a file that moved is retried, a stable file passes the error on', () => {
  const database = makeDb(...ITEMS);
  let calls = 0;
  const r = withReadOnly(database, () => {
    calls += 1;
    if (calls === 1) {
      utimesSync(database, new Date(), new Date(Date.now() + 50000));
      throw new Error('database disk image is malformed');
    }
    return 'fine';
  });
  assert.equal(r.result, 'fine');
  assert.throws(() => withReadOnly(database, () => { throw new Error('boom'); }), /boom/);
});

// ---------- configuration ----------
test('config: the check is registered and its parameters are validated', () => {
  assert.equal(CHECKS['sqlite-query'], check);
  const base = { key: 'q', check: 'sqlite-query', database: '/data/x.sqlite', query: 'SELECT 1' };
  const cfg = validateConfig({ checks: [{ ...base, delta: true, on_decrease: 'rebase', null_as: 0, warn_above: 1, crit_above: 5, unit: 'req' }] });
  assert.equal(cfg.checks[0].params.query, 'SELECT 1');
  const bad = (extra, re) => assert.throws(() => validateConfig({ checks: [{ ...base, ...extra }] }), re);
  bad({ database: 'relative.sqlite' }, /absolute path/);
  bad({ query: 'DELETE FROM t' }, /must start with SELECT or WITH/);
  bad({ query: 'SELECT 1; SELECT 2' }, /single statement/);
  bad({ warn_above: 9, crit_above: 5 }, /warn_above must not exceed crit_above/);
  bad({ warn_below: 1, crit_below: 5 }, /warn_below must not be lower than crit_below/);
  bad({ null_as: 'zero' }, /null_as must be a number/);
  bad({ delta: 'yes' }, /delta must be true or false/);
  bad({ delta: true }, /delta needs on_decrease/);
  bad({ delta: true, on_decrease: 'reset' }, /delta needs on_decrease/);
  bad({ on_decrease: 'rebase' }, /only applies with delta/);
  bad({ colum: 'x' }, /unknown key "colum"/);
  assert.throws(() => validateConfig({ checks: [{ key: 'q', check: 'sqlite-query', database: '/x' }] }), /required value "query" is missing/);
});
