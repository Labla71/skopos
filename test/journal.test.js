import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../lib/config.js';
import { CHECKS } from '../lib/checks/index.js';
import { createJournalCheck, parseEntries } from '../lib/checks/journal.js';
import { createFailedUnitsCheck, parseFailed } from '../lib/checks/failed-units.js';

// All sources are injected: no test runs journalctl or systemctl.
const ok = (stdout, extra = {}) => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false, ...extra });
const entry = (cursor, message, unit) => JSON.stringify({ __CURSOR: cursor, MESSAGE: message, ...(unit ? { _SYSTEMD_UNIT: unit } : {}) });
const out = (...e) => `${e.join('\n')}\n`;
const stateOf = (init = {}) => {
  const data = { ...init };
  return { data, ctx: { state: { get: (k) => data[k], set: (k, v) => { data[k] = v; } } } };
};

test('journal: first run looks back 24 hours, counts all entries, keeps a few samples, stores the cursor', async () => {
  const seen = [];
  const c = createJournalCheck({ journal: async (args) => { seen.push(args); return ok(out(
    entry('c1', 'disk on fire', 'a.service'), entry('c2', 'second'), entry('c3', 'third', 'b.service'), entry('c4', 'fourth'), entry('c5', 'fifth'))); } });
  const { data, ctx } = stateOf();
  const [r] = await c.measure({}, ctx);
  assert.deepEqual([r.key, r.value, r.unit, r.status], ['errors', 5, 'entries', 'warn']);
  assert.match(r.reason, /5 journal entries in the last 24 hours/);
  assert.match(r.reason, /a\.service: disk on fire/);
  assert.match(r.reason, /…$/, 'more entries than samples are counted, not listed');
  assert.ok(!r.reason.includes('fourth'));
  assert.equal(data.cursor, 'c5');
  assert.deepEqual(seen[0].slice(seen[0].indexOf('--since')), ['--since', '24 hours ago']);
  assert.deepEqual(seen[0].slice(seen[0].indexOf('-p'), seen[0].indexOf('-p') + 2), ['-p', 'err']);
});

test('journal: later run uses the cursor; nothing new is ok and keeps the cursor', async () => {
  let args;
  const { data, ctx } = stateOf({ cursor: 'c5' });
  const [r] = await createJournalCheck({ journal: async (a) => { args = a; return ok(''); } }).measure({}, ctx);
  assert.deepEqual([r.value, r.status, r.reason], [0, 'ok', undefined]);
  assert.equal(data.cursor, 'c5');
  assert.deepEqual(args.slice(args.indexOf('--after-cursor')), ['--after-cursor', 'c5']);
});

test('journal: an empty first run is a measured 0, not unknown', async () => {
  const { data, ctx } = stateOf();
  const [r] = await createJournalCheck({ journal: async () => ok('') }).measure({}, ctx);
  assert.deepEqual([r.value, r.status], [0, 'ok']);
  assert.equal(data.cursor, undefined);
});

test('journal: units, priority and severity go into the command and the result', async () => {
  let args;
  const c = createJournalCheck({ journal: async (a) => { args = a; return ok(out(entry('c1', 'x'))); } });
  const [r] = await c.measure({ units: ['a.service', 'b.service'], priority: 'crit', severity: 'crit' }, stateOf().ctx);
  assert.equal(r.status, 'crit');
  assert.equal(args.filter((a) => a === '-u').length, 2);
  assert.deepEqual(args.slice(args.indexOf('-u'), args.indexOf('-u') + 2), ['-u', 'a.service']);
  assert.equal(args[args.indexOf('-p') + 1], 'crit');
});

test('journal: exclusion patterns drop matching entries from the count, but the cursor still advances', async () => {
  const c = createJournalCheck({ journal: async () => ok(out(entry('c1', 'Noisy driver failed'), entry('c2', 'real problem'), entry('c3', 'NOISY again'))) });
  const { data, ctx } = stateOf();
  const [r] = await c.measure({ exclude: ['^noisy'] }, ctx);
  assert.equal(r.value, 1);
  assert.match(r.reason, /real problem/);
  assert.equal(data.cursor, 'c3');
  const all = await createJournalCheck({ journal: async () => ok(out(entry('c1', 'noisy'))) }).measure({ exclude: ['noisy'] }, stateOf().ctx);
  assert.deepEqual([all[0].value, all[0].status], [0, 'ok']);
});

test('journal: unreadable journal is unknown with a reason and the cursor stays', async () => {
  const cases = [
    ok('', { stderr: 'Hint: You are currently not seeing messages from other users and the system.' }),
    { code: 1, stdout: '', stderr: 'Failed to get journal', timedOut: false },
    { code: null, stdout: '', stderr: '', spawnError: new Error('ENOENT') },
    { code: null, stdout: '', stderr: '', timedOut: true },
    ok('not json\n'),
  ];
  for (const res of cases) {
    const { data, ctx } = stateOf({ cursor: 'keep' });
    const [r] = await createJournalCheck({ journal: async () => res }).measure({}, ctx);
    assert.equal(r.status, 'unknown');
    assert.equal(r.value, undefined);
    assert.ok(r.reason);
    assert.equal(data.cursor, 'keep');
  }
});

test('journal: a rejected cursor falls back to 24 hours once, and says so — even when all is well', async () => {
  const seen = [];
  const c = createJournalCheck({ journal: async (args) => {
    seen.push(args);
    return args.includes('--after-cursor') ? { code: 1, stdout: '', stderr: 'Failed to seek to cursor: Invalid argument', timedOut: false } : ok(out(entry('n1', 'boom')));
  } });
  const { data, ctx } = stateOf({ cursor: 'garbage' });
  const [r] = await c.measure({}, ctx);
  assert.deepEqual([r.value, r.status], [1, 'warn']);
  assert.match(r.reason, /cursor was rejected/);
  assert.equal(data.cursor, 'n1');
  assert.deepEqual(seen.map((a) => a.includes('--since')), [false, true]);
  const quiet = stateOf({ cursor: 'garbage' });
  const [q] = await createJournalCheck({ journal: async (args) => (args.includes('--after-cursor')
    ? { code: 1, stdout: '', stderr: 'Failed to seek to cursor', timedOut: false } : ok('')) }).measure({}, quiet.ctx);
  assert.deepEqual([q.value, q.status], [0, 'ok']);
  assert.match(q.reason, /cursor was rejected/);
});

test('journal: very many entries are counted, not stored; the output limit makes the count a lower bound', async () => {
  const many = out(...Array.from({ length: 5000 }, (_, i) => entry(`c${i}`, `error ${i}`)));
  const { ctx } = stateOf();
  const [r] = await createJournalCheck({ journal: async () => ok(many) }).measure({}, ctx);
  assert.equal(r.value, 5000);
  assert.ok(r.reason.length < 600, 'the reason stays short');

  // Output cut at the buffer limit: the last line is incomplete and must not count or set the cursor.
  const big = 'x'.repeat(8 * 1024 * 1024 - 100);
  const cut = `${out(entry('c1', 'first'), entry('c2', 'second'))}${JSON.stringify({ __CURSOR: 'c3', MESSAGE: big }).slice(0, 8 * 1024 * 1024)}`;
  const s = stateOf();
  const [p] = await createJournalCheck({ journal: async () => ok(cut) }).measure({}, s.ctx);
  assert.equal(p.value, 2);
  assert.match(p.reason, /lower bound/);
  assert.equal(s.data.cursor, 'c2');
});

test('journal: parseEntries skips journalctl hints and rejects garbage', () => {
  assert.deepEqual(parseEntries('-- No entries --\n').count, 0);
  assert.ok(parseEntries('{"MESSAGE":"a"}\nnope\n').error);
  assert.equal(parseEntries(JSON.stringify({ MESSAGE: [104, 105] }) + '\n').samples[0], 'hi');
});

test('journal: config validation', () => {
  const v = (p) => CHECKS.journal.validate(p);
  assert.deepEqual(v({}), []);
  assert.deepEqual(v({ units: ['a.service'], priority: 'warning', exclude: ['^x.*y$'], severity: 'crit' }), []);
  for (const bad of [{ units: [] }, { units: ['a b'] }, { priority: 'info' }, { exclude: ['('] }, { exclude: [''] }, { exclude: 'x' }, { severity: 'high' }]) {
    assert.ok(v(bad).length, JSON.stringify(bad));
  }
  const cfg = validateConfig({ checks: [{ check: 'journal', key: 'errors', units: ['a.service'] }, { check: 'failed-units', key: 'failed' }] });
  assert.equal(cfg.checks.length, 2);
  assert.throws(() => validateConfig({ checks: [{ check: 'journal', key: 'e', bogus: 1 }] }), /bogus/);
});

// ---------- failed-units ----------
const failed = (res, params = {}) => createFailedUnitsCheck({ list: async () => res }).measure(params, {});

test('failed-units: counts failed units and names them; none is a measured 0', async () => {
  const text = 'a.service loaded failed failed A\nb.timer   loaded failed failed B\n';
  const [r] = await failed(ok(text));
  assert.deepEqual([r.key, r.value, r.status], ['failed', 2, 'warn']);
  assert.match(r.reason, /a\.service, b\.timer/);
  const [n] = await failed(ok(''));
  assert.deepEqual([n.value, n.status, n.reason], [0, 'ok', undefined]);
  const [c] = await failed(ok(text), { severity: 'crit', ignore: ['a.service'] });
  assert.deepEqual([c.value, c.status], [1, 'crit']);
});

test('failed-units: systemctl failing is unknown, never 0', async () => {
  for (const res of [{ code: 1, stdout: '', stderr: 'boom', timedOut: false }, { code: null, stdout: '', stderr: '', spawnError: new Error('ENOENT') }, { code: null, stdout: '', stderr: '', timedOut: true }]) {
    const [r] = await failed(res);
    assert.equal(r.status, 'unknown');
    assert.ok(r.reason);
  }
});

test('failed-units: long lists are shortened; parseFailed ignores noise', async () => {
  const many = Array.from({ length: 8 }, (_, i) => `u${i}.service loaded failed failed x`).join('\n');
  const [r] = await failed(ok(many));
  assert.equal(r.value, 8);
  assert.match(r.reason, /…$/);
  assert.deepEqual(parseFailed('\n  \n● x.service loaded failed\n'), ['x.service']);
  assert.ok(CHECKS['failed-units'].validate({ ignore: ['a b'] }).length);
});
