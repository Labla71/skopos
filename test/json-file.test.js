import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../lib/config.js';
import { CHECKS } from '../lib/checks/index.js';
import defaultCheck, { createJsonFileCheck, lookup } from '../lib/checks/json-file.js';

const dir = mkdtempSync(join(tmpdir(), 'skopos-jf-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const isRoot = process.getuid?.() === 0;
const NOW = 1_800_000_000_000;
const check = createJsonFileCheck({ now: () => NOW });
let counter = 0;

// Writes a JSON file whose mtime is `ageSeconds` before the fixed "now".
function makeFile(content, ageSeconds = 30) {
  const path = join(dir, `f-${(counter += 1)}.json`);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  const t = new Date(NOW - ageSeconds * 1000);
  utimesSync(path, t, t);
  return path;
}
const by = (results) => Object.fromEntries(results.map((r) => [r.key, r]));
const run = async (params) => by(await check.measure(params, {}));

test('field: the value is stored, without ratings it is ok; age comes from the mtime', async () => {
  const file = makeFile({ status: 'ok', count: 4 }, 90);
  const r = await run({ file, field: 'status' });
  assert.deepEqual(r.value, { key: 'value', value: 'ok', status: 'ok' });
  assert.deepEqual(r.age, { key: 'age', value: 90, unit: 's', status: 'ok' });
});

test('expected: deviation is crit by default, warn on request; booleans compare as text; no coercion', async () => {
  const file = makeFile({ status: 'auto-rolled-back', up: true, n: 5 });
  let r = await run({ file, field: 'status', expected: 'ok' });
  assert.equal(r.value.status, 'crit');
  assert.match(r.value.reason, /"auto-rolled-back", expected "ok"/);
  r = await run({ file, field: 'status', expected: 'ok', severity: 'warn' });
  assert.equal(r.value.status, 'warn');
  r = await run({ file, field: 'status', expected: 'auto-rolled-back' });
  assert.equal(r.value.status, 'ok');
  r = await run({ file, field: 'up', expected: true });
  assert.deepEqual([r.value.value, r.value.status], ['true', 'ok']);
  assert.equal((await run({ file, field: 'up', expected: false })).value.status, 'crit');
  assert.equal((await run({ file, field: 'n', expected: 5 })).value.status, 'ok');
  assert.equal((await run({ file, field: 'n', expected: '5' })).value.status, 'crit', 'number is not the text "5"');
});

test('numeric thresholds on the field, above and below', async () => {
  const file = makeFile({ level: 0.4, deep: { list: [{ v: 12 }] } });
  assert.equal((await run({ file, field: 'level', warn_below: 0.5 })).value.status, 'warn');
  assert.equal((await run({ file, field: 'level', warn_below: 0.5, crit_below: 0.4 })).value.status, 'crit');
  assert.equal((await run({ file, field: 'level', warn_below: 0.3 })).value.status, 'ok');
  assert.equal((await run({ file, field: 'deep.list.0.v', warn_above: 10, crit_above: 20, unit: 'pcs' })).value.status, 'warn');
  assert.equal((await run({ file, field: 'deep.list.0.v', unit: 'pcs' })).value.unit, 'pcs');
});

test('age thresholds: at or above, from the mtime', async () => {
  const file = makeFile({ a: 1 }, 7200);
  assert.equal((await run({ file, warn_age_seconds: 3600, crit_age_seconds: 86400 })).age.status, 'warn');
  assert.equal((await run({ file, warn_age_seconds: 60, crit_age_seconds: 7200 })).age.status, 'crit');
  assert.equal((await run({ file, warn_age_seconds: 7201 })).age.status, 'ok');
  assert.equal(Object.keys(await run({ file })).join(), 'age', 'without field only the age is measured');
});

test('missing file: every measurement is unknown with the reason, no value', async () => {
  const r = await run({ file: join(dir, 'gone.json'), field: 'status' });
  for (const k of ['value', 'age']) {
    assert.equal(r[k].status, 'unknown');
    assert.equal(r[k].reason, 'file not found');
    assert.equal(r[k].value, undefined);
  }
  assert.deepEqual(Object.keys(await run({ file: join(dir, 'gone.json') })), ['age']);
});

test('no read permission: unknown "no read permission", not a zero', { skip: isRoot && 'root ignores file modes' }, async () => {
  const file = makeFile({ status: 'ok' });
  chmodSync(file, 0o000);
  try {
    const r = await run({ file, field: 'status' });
    assert.deepEqual([r.value.status, r.value.reason, r.age.status, r.age.reason], ['unknown', 'no read permission', 'unknown', 'no read permission']);
  } finally {
    chmodSync(file, 0o644);
  }
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  const inside = join(locked, 'x.json');
  writeFileSync(inside, '{}');
  chmodSync(locked, 0o000);
  try {
    assert.equal((await run({ file: inside, field: 'a' })).value.reason, 'no read permission');
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('half-written, empty, and non-JSON content is unknown for the value; the age is still measured', async () => {
  for (const content of ['{"status": "ok", "cou', '', 'not json', '{"a": 1}}']) {
    const r = await run({ file: makeFile(content), field: 'a' });
    assert.equal(r.value.status, 'unknown', JSON.stringify(content));
    assert.match(r.value.reason, /not valid JSON/);
    assert.equal(r.age.status, 'ok');
  }
});

test('missing field and wrong type are unknown with a reason', async () => {
  const file = makeFile({ a: { b: 1 }, list: [1, 2], nothing: null, text: 'abc', flag: true, big: 3 });
  let r = await run({ file, field: 'x' });
  assert.match(r.value.reason, /field "x" is missing/);
  assert.match((await run({ file, field: 'a.c' })).value.reason, /missing/);
  assert.match((await run({ file, field: 'text.length' })).value.reason, /missing/, 'no property access on strings');
  assert.match((await run({ file, field: 'list.5' })).value.reason, /missing/);
  assert.match((await run({ file, field: 'a' })).value.reason, /type object/);
  assert.match((await run({ file, field: 'list' })).value.reason, /type array/);
  assert.match((await run({ file, field: 'nothing' })).value.reason, /type null/);
  r = await run({ file, field: 'text', warn_above: 1 });
  assert.equal(r.value.status, 'unknown');
  assert.match(r.value.reason, /text, numeric thresholds need a number/);
  r = await run({ file, field: 'flag', warn_above: 1 });
  assert.equal(r.value.status, 'unknown', 'a boolean is text here, not a number');
  for (const k of ['a', 'list', 'nothing', 'x']) assert.equal((await run({ file, field: k })).value.value, undefined);
});

test('lookup: only own properties, __proto__ is not a way in', () => {
  assert.deepEqual(lookup({ a: 1 }, 'a'), { value: 1 });
  assert.deepEqual(lookup({ a: 1 }, 'toString'), { missing: true });
  assert.deepEqual(lookup({ a: 1 }, '__proto__'), { missing: true });
  assert.deepEqual(lookup([10, 20], '1'), { value: 20 });
});

test('age: a modification time in the future is unknown beyond a small tolerance; a directory and a huge file are unknown', async () => {
  let r = await run({ file: makeFile({ a: 1 }, -5000), field: 'a' });
  assert.equal(r.age.status, 'unknown');
  assert.match(r.age.reason, /in the future/);
  assert.equal(r.value.status, 'ok', 'the field itself is fine');
  r = await run({ file: makeFile({ a: 1 }, -10), field: 'a' });
  assert.deepEqual([r.age.value, r.age.status], [0, 'ok'], 'small skew is clamped to 0');
  r = await run({ file: dir, field: 'a' });
  assert.equal(r.value.status, 'unknown');
  assert.match(r.value.reason, /directory|not a file/);
  r = await run({ file: makeFile(`{"a": "${'x'.repeat(1024 * 1024)}"}`), field: 'a' });
  assert.match(r.value.reason, /larger than/);
});

test('config: registered, parameters validated', () => {
  assert.equal(CHECKS['json-file'], defaultCheck);
  const base = { key: 'j', check: 'json-file', file: '/data/x.json' };
  const cfg = validateConfig({ checks: [{ ...base, field: 'status', expected: 'ok', severity: 'warn', warn_age_seconds: 60, crit_age_seconds: 600 }] });
  assert.equal(cfg.checks[0].params.field, 'status');
  const bad = (extra, re) => assert.throws(() => validateConfig({ checks: [{ ...base, ...extra }] }), re);
  bad({ file: 'x.json' }, /absolute path/);
  bad({ expected: 'ok' }, /need a field/);
  bad({ field: 'a', expected: {} }, /expected must be a string, number or boolean/);
  bad({ field: 'a', expected: 1, warn_above: 1 }, /cannot be combined/);
  bad({ field: 'a', severity: 'bad' }, /severity must be "warn" or "crit"/);
  bad({ warn_age_seconds: 9, crit_age_seconds: 1 }, /warn_age_seconds must not exceed/);
  bad({ warn_age_seconds: -1 }, /warn_age_seconds must be a number ≥ 0/);
  bad({ field: 'a', warn_above: 9, crit_above: 1 }, /warn_above must not exceed/);
  bad({ field: 'a', fild: 'x' }, /unknown key "fild"/);
});
