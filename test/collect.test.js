import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COLLECT_DEFAULTS, validateCollectConfig } from '../lib/collect/config.js';
import { buildCommand, interpretFetch } from '../lib/collect/fetch.js';
import { deliver, emptyState, overrideFor, processPoll } from '../lib/collect/machine.js';
import { commandNotifier } from '../lib/collect/notify.js';
import { collectOnce, formatPoll } from '../lib/collect/run.js';
import { fileStateStore } from '../lib/collect/store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2026-01-05T10:00:00Z');
const at = (min) => new Date(T0 + min * 60_000);
const iso = (min) => at(min).toISOString();
const host = { name: 'example-host', ssh: 'example-host', local: false, command: '/opt/skopos/bin/skopos.js' };
const host2 = { ...host, name: 'example-host-2', ssh: 'example-host-2' };
const baseCfg = (extra = {}) => ({ ...COLLECT_DEFAULTS, overrides: {}, hosts: [host], ...extra });

// ---- Report sequences as fixtures: one Skopos run per entry, `rows` = { key: status | { check, status } }
function report({ runs = [], stale = false, now = runs.at(-1)?.min ?? 0, catalog = [] }) {
  const history = runs.flatMap(({ min, rows }) => Object.entries(rows).map(([key, s]) => {
    const status = typeof s === 'object' ? s.status : s;
    return {
      check: typeof s === 'object' ? s.check : 'memory', key, status,
      reason: status === 'ok' ? null : `${key} reason line`,
      value: status === 'unknown' ? null : 91.5, unit: '%', time: new Date(T0 + min * 60_000 + 50).toISOString(),
    };
  }));
  const last = runs.at(-1)?.min ?? now - 20;
  return {
    report_version: 1, generated_at: iso(now), since: iso(now - 30),
    heartbeat: { run_id: 1, started_at: iso(last), finished_at: new Date(T0 + last * 60_000 + 200).toISOString(), duration_ms: 200, age_seconds: (now - last) * 60, interval_minutes: 5, stale, counts: {}, version: 'x', runs_in_window: runs.length },
    checks: catalog.map(([check, key]) => ({ check, key, status: 'ok', reason: null, value: 1, unit: '%', time: new Date(T0 + last * 60_000 + 50).toISOString() })), history,
  };
}
const res = (r) => ({ code: 0, stdout: JSON.stringify(r), stderr: '' });
const unreachable = { code: 255, stdout: '', stderr: 'ssh: connect to host example-host port 22: No route to host' };
const bad = (min, key = 'memory.ram', status = 'crit') => ({ min, rows: { [key]: status } });
const ok = (min, key = 'memory.ram') => ({ min, rows: { [key]: 'ok' } });

function fakeNotifier() {
  const n = { events: [], fail: false, notify: async (ev) => { if (n.fail) throw new Error('downstream unavailable'); n.events.push(JSON.parse(JSON.stringify(ev))); } };
  return n;
}
function memStore() { let s = null; return { load: async () => (s ? JSON.parse(s) : null), save: async (st) => { s = JSON.stringify(st); } }; }
const env = (cfg = baseCfg()) => ({ cfg, notifier: fakeNotifier(), store: memStore() });
const poll = (e, min, answers) => collectOnce({ cfg: e.cfg, store: e.store, notifier: e.notifier, now: at(min), exec: async (h) => answers[h.name] });
const types = (e) => e.notifier.events.map((ev) => `${ev.type}:${ev.host}:${ev.kind === 'host' ? ev.code : ev.key}`);

// ---- retirement of checks removed from the configuration

const stateOf = async (e) => e.store.load();
const confirmedKeys = (st) => Object.values(st.entities).filter((x) => x.confirmed).map((x) => x.key);

test('a confirmed check missing from the latest run is retired with a "removed" recovery', async () => {
  const e = env();
  await poll(e, 6, { 'example-host': res(report({ runs: [bad(0, 'sol.a'), bad(5, 'sol.a')], catalog: [['memory', 'sol.a']] })) });
  assert.deepEqual(types(e), ['problem:example-host:sol.a']);
  const r = await poll(e, 11, { 'example-host': res(report({ runs: [ok(11, 'other.x')], now: 11, catalog: [['memory', 'other.x']] })) });
  assert.deepEqual(types(e), ['problem:example-host:sol.a', 'recovery:example-host:sol.a']);
  const ev = e.notifier.events.at(-1);
  assert.equal(ev.removed, true);
  assert.match(ev.summary, /removed from the configuration/);
  assert.equal(r.problems, 0);
  assert.deepEqual(confirmedKeys(await stateOf(e)), []);
  await poll(e, 16, { 'example-host': res(report({ runs: [ok(16, 'other.x')], now: 16, catalog: [['memory', 'other.x']] })) });
  assert.deepEqual(Object.keys((await stateOf(e)).entities).filter((k) => k.includes('sol')), []); // gone after delivery
  assert.equal(e.notifier.events.length, 2);
});

test('an unconfirmed entity of a removed check is dropped without an event', async () => {
  const e = env();
  await poll(e, 1, { 'example-host': res(report({ runs: [bad(0, 'sol.a')], catalog: [['memory', 'sol.a']] })) });
  await poll(e, 6, { 'example-host': res(report({ runs: [ok(6, 'other.x')], now: 6, catalog: [['memory', 'other.x']] })) });
  assert.equal(e.notifier.events.length, 0);
  assert.deepEqual(Object.keys((await stateOf(e)).entities).filter((k) => k.includes('sol')), []);
});

test('no retirement without a trustworthy catalog: unreachable, stale, empty, or the instance still reports', async () => {
  const e = env();
  await poll(e, 6, { 'example-host': res(report({ runs: [bad(0, 'sol.a'), bad(5, 'sol.a')], catalog: [['memory', 'sol.a']] })) });
  await poll(e, 11, { 'example-host': unreachable });
  await poll(e, 16, { 'example-host': res({ ...report({ runs: [ok(16, 'other.x')], now: 16, stale: true, catalog: [['memory', 'other.x']] }) }) });
  await poll(e, 21, { 'example-host': res(report({ runs: [ok(20, 'other.x')], now: 21, catalog: [] })) }); // empty catalog
  // the check itself fails: only the instance row (unknown) is left, the instance is still configured
  await poll(e, 26, { 'example-host': res(report({ runs: [ok(25, 'other.x')], now: 26, catalog: [['memory', 'sol']] })) });
  const st = await stateOf(e);
  assert.deepEqual(confirmedKeys(st), ['sol.a']);
  assert.equal(Object.values(st.entities).some((x) => x.retired), false);
  assert.ok(!e.notifier.events.some((ev) => ev.removed));
});

test('a single item removed from a check that still reports its other items is retired', async () => {
  const e = env();
  const rows = (min, a, b) => ({ min, rows: { 'svc.a': { check: 'systemd', status: a }, 'svc.b': { check: 'systemd', status: b } } });
  await poll(e, 6, { 'example-host': res(report({ runs: [rows(0, 'crit', 'ok'), rows(5, 'crit', 'ok')], catalog: [['systemd', 'svc.a'], ['systemd', 'svc.b']] })) });
  assert.deepEqual(types(e), ['problem:example-host:svc.a']);
  const r = await poll(e, 11, { 'example-host': res(report({ runs: [{ min: 11, rows: { 'svc.b': { check: 'systemd', status: 'ok' } } }], now: 11, catalog: [['systemd', 'svc.b']] })) });
  assert.deepEqual(types(e), ['problem:example-host:svc.a', 'recovery:example-host:svc.a']);
  assert.equal(e.notifier.events.at(-1).removed, true);
  assert.equal(r.problems, 0);
  const st = await stateOf(e);
  assert.ok(Object.values(st.entities).some((x) => x.key === 'svc.b'), 'the sibling item stays');
});

test('an item of a check that failed as a whole is not retired (bare instance row, or invalid sub-key)', async () => {
  for (const bareKey of ['svc', 'svc.?']) {
    const e = env();
    await poll(e, 6, { 'example-host': res(report({ runs: [{ min: 0, rows: { 'svc.a': { check: 'systemd', status: 'crit' } } }, { min: 5, rows: { 'svc.a': { check: 'systemd', status: 'crit' } } }], catalog: [['systemd', 'svc.a']] })) });
    await poll(e, 11, { 'example-host': res(report({ runs: [ok(11, 'other.x')], now: 11, catalog: [['systemd', bareKey]] })) });
    const st = await stateOf(e);
    assert.deepEqual(confirmedKeys(st), ['svc.a'], bareKey);
    assert.ok(!e.notifier.events.some((ev) => ev.removed), bareKey);
  }
});

test('a retired check that comes back is a normal entity again', async () => {
  const e = env();
  await poll(e, 6, { 'example-host': res(report({ runs: [bad(0, 'sol.a'), bad(5, 'sol.a')], catalog: [['memory', 'sol.a']] })) });
  e.notifier.fail = true; // recovery stays pending, the entity stays
  await poll(e, 11, { 'example-host': res(report({ runs: [ok(11, 'other.x')], now: 11, catalog: [['memory', 'other.x']] })) });
  e.notifier.fail = false;
  await poll(e, 16, { 'example-host': res(report({ runs: [bad(15, 'sol.a'), bad(16, 'sol.a')], now: 16, catalog: [['memory', 'sol.a']] })) });
  const st = await stateOf(e);
  assert.deepEqual(confirmedKeys(st), ['sol.a']);
  assert.equal(Object.values(st.entities).some((x) => x.retired), false);
});

// ---- soft/hard state

test('a single spike produces no event', async () => {
  const e = env();
  await poll(e, 1, { 'example-host': res(report({ runs: [bad(0)] })) });
  await poll(e, 6, { 'example-host': res(report({ runs: [ok(5)] })) });
  await poll(e, 11, { 'example-host': res(report({ runs: [bad(10)] })) });
  assert.deepEqual(e.notifier.events, []);
});

test('N runs not ok -> exactly one problem event with a snapshot of the problem', async () => {
  const e = env();
  await poll(e, 1, { 'example-host': res(report({ runs: [bad(0, 'memory.ram', 'warn')] })) });
  await poll(e, 6, { 'example-host': res(report({ runs: [bad(5)] })) });
  assert.deepEqual(types(e), ['problem:example-host:memory.ram']);
  const [ev] = e.notifier.events;
  assert.equal(ev.event_version, 1);
  assert.equal(ev.kind, 'check');
  assert.equal(ev.code, 'check_problem');
  assert.equal(ev.check, 'memory');
  assert.equal(ev.severity, 'crit');
  assert.equal(ev.count, 2);
  assert.equal(ev.confirm_after, 2);
  assert.equal(ev.first_seen, new Date(T0 + 50).toISOString());
  assert.deepEqual(ev.last, { status: 'crit', value: 91.5, unit: '%', reason: 'memory.ram reason line', time: new Date(T0 + 5 * 60_000 + 50).toISOString() });
  assert.match(ev.summary, /example-host memory\.ram: problem confirmed/);
});

test('runs count, not polls: two runs in one poll confirm', async () => {
  const e = env();
  await poll(e, 11, { 'example-host': res(report({ runs: [bad(5, 'memory.ram', 'warn'), bad(10, 'memory.ram', 'warn')] })) });
  assert.deepEqual(types(e), ['problem:example-host:memory.ram']);
  assert.equal(e.notifier.events[0].severity, 'warn');
});

test('an ongoing problem produces no further events', async () => {
  const e = env();
  for (let m = 0; m <= 30; m += 5) await poll(e, m + 1, { 'example-host': res(report({ runs: [bad(m)] })) });
  assert.equal(e.notifier.events.length, 1);
});

test('unknown neither confirms nor recovers a threshold problem; 3 unknown runs -> "not measuring"', async () => {
  const e = env();
  await poll(e, 11, { 'example-host': res(report({ runs: [bad(0, 'memory.ram', 'unknown'), bad(5, 'memory.ram', 'unknown'), bad(10, 'memory.ram', 'unknown')] })) });
  assert.deepEqual(e.notifier.events.map((ev) => [ev.kind, ev.code, ev.severity]), [['measurement', 'check_unknown', 'unknown']]);
  const e2 = env();
  await poll(e2, 6, { 'example-host': res(report({ runs: [bad(0), bad(5)] })) });
  await poll(e2, 21, { 'example-host': res(report({ runs: [bad(10, 'memory.ram', 'unknown'), bad(15, 'memory.ram', 'unknown'), bad(20, 'memory.ram', 'unknown')] })) });
  assert.deepEqual(types(e2), ['problem:example-host:memory.ram', 'problem:example-host:memory.ram']); // second one: measurement
  assert.equal(e2.notifier.events[1].kind, 'measurement');
});

test('override: crit on a systemd check confirms after one run, warn does not', async () => {
  const e = env(baseCfg({ overrides: { systemd: { crit_confirm_runs: 1 } } }));
  await poll(e, 1, { 'example-host': res(report({ runs: [{ min: 0, rows: { 'services.a': { check: 'systemd', status: 'warn' }, 'services.b': { check: 'systemd', status: 'crit' } } }] })) });
  assert.deepEqual(types(e), ['problem:example-host:services.b']);
  assert.equal(e.notifier.events[0].confirm_after, 1);
});

// ---- recovery

test('recovery over N runs -> one recovery event; a single ok is not enough', async () => {
  const e = env();
  await poll(e, 6, { 'example-host': res(report({ runs: [bad(0), bad(5)] })) });
  await poll(e, 11, { 'example-host': res(report({ runs: [ok(10)] })) });
  assert.equal(e.notifier.events.length, 1);
  await poll(e, 16, { 'example-host': res(report({ runs: [ok(15)] })) });
  assert.deepEqual(types(e), ['problem:example-host:memory.ram', 'recovery:example-host:memory.ram']);
  assert.equal(e.notifier.events[1].time, new Date(T0 + 15 * 60_000 + 50).toISOString());
});

// ---- host dependency

test('unreachable host -> one host event after two polls, recovery once it answers', async () => {
  const e = env();
  await poll(e, 1, { 'example-host': unreachable });
  assert.equal(e.notifier.events.length, 0);
  await poll(e, 6, { 'example-host': unreachable });
  await poll(e, 11, { 'example-host': unreachable });
  assert.deepEqual(types(e), ['problem:example-host:host_unreachable']);
  assert.match(e.notifier.events[0].last.message, /No route to host/);
  await poll(e, 16, { 'example-host': res(report({ runs: [ok(15)] })) });
  await poll(e, 21, { 'example-host': res(report({ runs: [ok(20)] })) });
  assert.deepEqual(types(e), ['problem:example-host:host_unreachable', 'recovery:example-host:host_unreachable']);
});

test('stale heartbeat -> one event at once, check events held back; recovered checks are dropped', async () => {
  const e = env();
  const last = [{ min: 0, rows: { 'memory.ram': 'crit', 'disk.root': 'crit' } }, { min: 5, rows: { 'memory.ram': 'crit', 'disk.root': 'crit' } }];
  const r = await poll(e, 21, { 'example-host': res(report({ runs: last, stale: true, now: 21 })) });
  assert.deepEqual(types(e), ['problem:example-host:heartbeat_stale']);
  assert.equal(r.stats.held, 2);
  for (let m = 26; m <= 56; m += 5) await poll(e, m, { 'example-host': res(report({ runs: [], stale: true, now: m })) });
  assert.equal(e.notifier.events.length, 1);
  const both = (m) => ({ min: m, rows: { 'memory.ram': 'ok', 'disk.root': 'ok' } });
  await poll(e, 61, { 'example-host': res(report({ runs: [both(60)] })) });
  const r2 = await poll(e, 66, { 'example-host': res(report({ runs: [both(65)] })) });
  assert.deepEqual(types(e), ['problem:example-host:heartbeat_stale', 'recovery:example-host:heartbeat_stale']);
  assert.equal(r2.pending, 0);
});

test('stale heartbeat, check still broken after return -> held event is delivered', async () => {
  const e = env();
  await poll(e, 21, { 'example-host': res(report({ runs: [bad(0), bad(5)], stale: true, now: 21 })) });
  await poll(e, 31, { 'example-host': res(report({ runs: [bad(30)] })) });
  assert.deepEqual(types(e).sort(), ['problem:example-host:heartbeat_stale', 'problem:example-host:memory.ram', 'recovery:example-host:heartbeat_stale']);
  assert.equal(e.notifier.events.find((ev) => ev.key === 'memory.ram').first_seen, new Date(T0 + 50).toISOString());
});

test('report errors are their own host findings (exit code, invalid JSON, version)', () => {
  assert.deepEqual(interpretFetch({ code: 1, stdout: '', stderr: 'database missing' }).finding.code, 'report_error');
  assert.deepEqual(interpretFetch({ code: 2, stdout: '', stderr: '' }).finding.code, 'report_usage');
  assert.equal(interpretFetch({ code: 7, stdout: '', stderr: '' }).finding.exit_code, 7);
  assert.equal(interpretFetch({ code: 0, stdout: '{"report_version":1', stderr: '' }).finding.code, 'report_invalid');
  assert.equal(interpretFetch({ code: 0, stdout: '{"report_version":99}', stderr: '' }).finding.report_version, 99);
  assert.equal(interpretFetch({ code: null, timedOut: true, stdout: '', stderr: '' }).finding.code, 'host_unreachable');
  assert.equal(interpretFetch(res(report({ runs: [ok(0)] }))).ok, true);
});

// ---- flapping

test('flapping -> one "unstable" event instead of more; calming down -> calm + final state', async () => {
  const e = env();
  const seq = ['crit', 'crit', 'ok', 'ok', 'crit', 'crit', 'ok', 'ok', 'crit', 'crit', 'ok', 'ok', 'crit', 'crit'];
  for (let i = 0; i < seq.length; i += 1) await poll(e, i * 5 + 1, { 'example-host': res(report({ runs: [bad(i * 5, 'memory.ram', seq[i])] })) });
  assert.deepEqual(types(e), ['problem:example-host:memory.ram', 'recovery:example-host:memory.ram', 'problem:example-host:memory.ram', 'unstable:example-host:memory.ram']);
  assert.equal(e.notifier.events[3].flapping.limit, 4);
  for (let m = 70; m <= 135; m += 5) await poll(e, m + 1, { 'example-host': res(report({ runs: [bad(m)] })) });
  assert.deepEqual(types(e).slice(4), ['calm:example-host:memory.ram', 'problem:example-host:memory.ram']);
  assert.equal(e.notifier.events[4].confirmed, true);
});

// ---- throttling

test('the 6th problem notification within an hour is sent as "throttled"', async () => {
  const e = env();
  const rows = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => [`disk.${k}`, 'crit']));
  const r = await poll(e, 6, { 'example-host': res(report({ runs: [{ min: 0, rows }, { min: 5, rows }] })) });
  assert.deepEqual(e.notifier.events.map((ev) => ev.type), ['problem', 'problem', 'problem', 'problem', 'problem', 'throttled', 'throttled']);
  const t = e.notifier.events[5];
  assert.equal(t.limit_per_hour, 5);
  assert.equal(t.suppressed.key, 'disk.f');
  assert.equal(r.stats.throttled, 2);
  await poll(e, 71, { 'example-host': res(report({ runs: [bad(70, 'disk.x'), bad(71, 'disk.x')] })) });
  assert.equal(e.notifier.events.at(-1).type, 'problem'); // an hour later there is room again
});

// ---- failures and restart

test('notifier failure -> retried on the next poll, order per entity kept', async () => {
  const e = env();
  e.notifier.fail = true;
  const r = await poll(e, 6, { 'example-host': res(report({ runs: [bad(0), bad(5)] })) });
  assert.equal(r.stats.failed, 1);
  assert.match(formatPoll(r), /failed=1 pending=1/);
  assert.match(r.errors[0], /downstream unavailable/);
  await poll(e, 16, { 'example-host': res(report({ runs: [ok(10), ok(15)] })) });
  e.notifier.fail = false;
  const r2 = await poll(e, 21, { 'example-host': res(report({ runs: [ok(20)] })) });
  assert.equal(r2.pending, 0);
  assert.deepEqual(types(e), ['problem:example-host:memory.ram', 'recovery:example-host:memory.ram']);
  assert.equal(e.notifier.events[0].time, new Date(T0 + 5 * 60_000 + 50).toISOString()); // snapshot of the transition
});

test('state survives a restart (file), watermark is passed as --since, overlap is not counted twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skopos-collect-'));
  const file = join(dir, 'state.json');
  const notifier = fakeNotifier();
  const calls = [];
  const run = (min, r) => collectOnce({ cfg: baseCfg(), store: fileStateStore(file), notifier, now: at(min), exec: async (h, args) => { calls.push(args); return res(r); } });
  await run(1, report({ runs: [bad(0)] }));
  assert.deepEqual(calls[0], ['report', '--json', '--since', iso(-29)]); // first poll: 30 min back
  assert.equal(statSync(file).mode & 0o777, 0o640);
  await run(6, report({ runs: [bad(5)] }));
  assert.equal(notifier.events.length, 1);
  assert.deepEqual(calls[1], ['report', '--json', '--since', new Date(T0 + 201).toISOString()]);
  await run(7, report({ runs: [ok(5)] })); // same run delivered again
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.values(state.entities).find((x) => x.kind === 'check').confirmed, true);
});

test('broken state file -> moved aside and reported, no silent fresh start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skopos-collect-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, '{broken');
  await assert.rejects(fileStateStore(file).load(), /state file unreadable/);
  assert.ok(readdirSync(dir).some((n) => n.startsWith('state.json.broken-')));
  assert.equal(await fileStateStore(file).load(), null);
});

test('several hosts: one dead host does not disturb the others', async () => {
  const e = env(baseCfg({ hosts: [host, host2] }));
  const r = await poll(e, 6, { 'example-host': unreachable, 'example-host-2': res(report({ runs: [bad(0), bad(5)] })) });
  assert.deepEqual(types(e), ['problem:example-host-2:memory.ram']);
  assert.match(formatPoll(r), /example-host=failed example-host-2=ok\/2/);
});

test('a quiet poll calls the notifier not at all', async () => {
  const e = env();
  let calls = 0;
  e.notifier.notify = async () => { calls += 1; };
  const r = await poll(e, 1, { 'example-host': res(report({ runs: [ok(0)] })) });
  assert.equal(calls, 0);
  assert.match(formatPoll(r), /problems=0 sent=0/);
});

test('deliver holds back check events of a dead host', async () => {
  const state = emptyState();
  processPoll(state, host, res(report({ runs: [bad(0), bad(5)], stale: true, now: 21 })), baseCfg(), at(21));
  const stats = await deliver(state, fakeNotifier(), baseCfg(), at(21));
  assert.deepEqual([stats.sent, stats.held, state.pending.length], [1, 1, 1]);
});

// ---- configuration, command line, notifier

const validRaw = () => ({ hosts: [{ name: 'example-host' }, { name: 'self', local: true }], state_file: '/var/lib/example/state.json', notifier: { type: 'command', command: ['/usr/local/bin/example-notify'] } });

test('config: defaults, ssh alias defaults to the name, local without ssh', () => {
  const c = validateCollectConfig(validRaw());
  assert.equal(c.confirm_runs, 2);
  assert.deepEqual(c.hosts.map((h) => [h.name, h.ssh, h.local]), [['example-host', 'example-host', false], ['self', undefined, true]]);
  assert.equal(c.notifier.timeout_seconds, 30);
});

test('config: strict, all errors at once', () => {
  const raw = { ...validRaw(), confirm_run: 3, flap_changes: 0, recover_runs: 11, hosts: [{ name: 'a b' }, { name: 'x', ssh: '-oProxyCommand=evil' }, { name: 'x', command: 'rel/path' }], notifier: { type: 'mail' }, state_file: 'state.json', overrides: { systemd: { crit_confirm: 1 } } };
  assert.throws(() => validateCollectConfig(raw), (e) => {
    for (const m of ['unknown key "confirm_run"', 'flap_changes must be', 'recover_runs must not exceed 10', 'name is missing or contains', 'ssh must be a host alias', 'appears twice', 'command must be an absolute path', 'unknown type "mail"', 'state_file', 'overrides.systemd: unknown key "crit_confirm"']) {
      assert.ok(e.messages.some((x) => x.includes(m)), `missing: ${m}\n${e.messages.join('\n')}`);
    }
    return true;
  });
});

test('fetch command: ssh without shell on this side, local directly', () => {
  assert.deepEqual(buildCommand(host, ['report', '--json']), { file: 'ssh', args: ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '--', 'example-host', '/opt/skopos/bin/skopos.js report --json'] });
  assert.deepEqual(buildCommand({ ...host, local: true }, ['report']), { file: '/opt/skopos/bin/skopos.js', args: ['report'] });
});

test('command notifier: event as JSON on stdin, exit 0 = delivered, otherwise an error with stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skopos-notify-'));
  const out = join(dir, 'out.json');
  const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(process.argv[1],s);process.exit(s.includes("fail")?3:0)})';
  const n = commandNotifier({ command: [process.execPath, '-e', script, out] });
  await n.notify({ type: 'problem', host: 'example-host' });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { type: 'problem', host: 'example-host' });
  await assert.rejects(commandNotifier({ command: [process.execPath, '-e', `${script};console.error("nope")`, out] }).notify({ type: 'fail' }), /exited with 3/);
  await assert.rejects(commandNotifier({ command: [join(dir, 'missing')] }).notify({}), /ENOENT/);
  await assert.rejects(commandNotifier({ command: [process.execPath, '-e', 'setTimeout(()=>{},5000)'], timeout_seconds: 1 }).notify({}), /killed by SIGTERM/);
});

test('skopos collect end to end: local host, command notifier, state file, exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skopos-collect-e2e-'));
  const fake = join(dir, 'fake-skopos');
  const rep = { ...report({ runs: [bad(0), bad(5)], now: 6 }) };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(rep));
  writeFileSync(fake, `#!/bin/sh\ncat "${join(dir, 'report.json')}"\n`);
  chmodSync(fake, 0o755);
  const notify = join(dir, 'notify');
  writeFileSync(notify, `#!/bin/sh\ncat >> "${join(dir, 'events.jsonl')}"\n[ -f "${join(dir, 'down')}" ] && exit 1\nexit 0\n`);
  chmodSync(notify, 0o755);
  const cfgFile = join(dir, 'collect.json');
  writeFileSync(cfgFile, JSON.stringify({ hosts: [{ name: 'example-host', local: true, command: fake }], state_file: join(dir, 'state.json'), notifier: { type: 'command', command: [notify] } }));
  const cli = (...a) => spawnSync(join(root, 'bin/skopos.js'), a, { encoding: 'utf8' });
  const r1 = cli('collect', '--config', cfgFile);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /collect: example-host=ok\/2 \| problems=1 sent=1/);
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((ev) => [ev.type, ev.key]), [['problem', 'memory.ram']]);
  // Notifier down: exit 1, event stays pending.
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ ...rep, history: [...rep.history, { ...rep.history[0], key: 'disk.root', time: iso(1) }, { ...rep.history[0], key: 'disk.root', time: iso(2) }] }));
  writeFileSync(join(dir, 'down'), '');
  const r2 = cli('collect', '--config', cfgFile);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /notifier failed/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).pending.length, 1);
  // Invalid configuration: exit 2.
  writeFileSync(cfgFile, JSON.stringify({ hosts: [] }));
  assert.equal(cli('collect', '--config', cfgFile).status, 2);
  assert.equal(cli('collect').status, 2);
});

test('shipped example configuration and user units fit the collector', () => {
  const c = validateCollectConfig(JSON.parse(readFileSync(join(root, 'config/example-collect.json'), 'utf8')));
  assert.equal(c.hosts.length, 3);
  const service = readFileSync(join(root, 'systemd/user/skopos-collect.service'), 'utf8');
  assert.match(service, /^ExecStart=\/opt\/skopos\/bin\/skopos\.js collect --config %h\/\.config\/skopos\/collect\.json$/m);
  assert.match(readFileSync(join(root, 'systemd/user/skopos-collect.timer'), 'utf8'), /^OnCalendar=\*:2\/5$/m);
});

test('report exit codes are separate findings: a changed code recovers the old one', async () => {
  const e = env();
  const exit = (code) => ({ code, stdout: '', stderr: 'x' });
  for (const m of [1, 6]) await poll(e, m, { 'example-host': exit(5) });
  for (const m of [11, 16]) await poll(e, m, { 'example-host': exit(6) });
  assert.deepEqual(e.notifier.events.map((ev) => [ev.type, ev.code, ev.exit_code]), [['problem', 'report_exit', 5], ['problem', 'report_exit', 6], ['recovery', 'report_exit', 5]]);
});

// ---- event counters (found in the review: a single occurrence was never confirmed)

function eventRun(min, rows) {
  const t = new Date(Date.UTC(2026, 8, 26, 12, min)).toISOString();
  const hb = { run_id: min + 1, started_at: t, finished_at: t, duration_ms: 1, age_seconds: 0, interval_minutes: 5, stale: false, counts: {}, version: 't', runs_in_window: 1 };
  const history = rows.map(([check, key, status]) => ({ check, key, status, value: status === 'ok' ? 0 : 1, unit: null, reason: status === 'ok' ? null : 'event', time: t }));
  return { res: { code: 0, stderr: '', stdout: JSON.stringify({ report_version: 1, generated_at: t, since: t, heartbeat: hb, checks: history, history }) }, now: new Date(Date.parse(t) + 60_000) };
}

test('event counters: one occurrence in a single run is confirmed with confirm_runs 1, other keys keep the default', () => {
  const cfg = validateCollectConfig({ ...validRaw(), overrides: { oom: { confirm_runs: 1 }, journal: { confirm_runs: 1 }, 'sqlite-query/new_errors': { confirm_runs: 1 } } });
  const state = emptyState();
  const seq = ['ok', 'crit', 'ok', 'ok'];
  seq.forEach((s, i) => {
    const { res, now } = eventRun(i * 5, [
      ['oom', 'oom.kills', s], ['journal', 'errors.errors', s === 'crit' ? 'warn' : 'ok'],
      ['sqlite-query', 'new_errors', s], ['sqlite-query', 'flush_age', s],
    ]);
    processPoll(state, host, res, cfg, now);
  });
  const events = state.pending.map((p) => `${p.event.type}:${p.event.check}/${p.event.key}`);
  for (const k of ['oom/oom.kills', 'journal/errors.errors', 'sqlite-query/new_errors']) {
    assert.ok(events.includes(`problem:${k}`), `problem ${k}: ${events}`);
    assert.ok(events.includes(`recovery:${k}`), `recovery ${k}: ${events}`);
  }
  assert.ok(!events.some((e) => e.endsWith('sqlite-query/flush_age')), 'a steady value still needs two runs');
});

test('without the override a single occurrence stays unconfirmed (documents why the override is needed)', () => {
  const cfg = validateCollectConfig(validRaw());
  const state = emptyState();
  ['ok', 'crit', 'ok', 'ok'].forEach((s, i) => { const { res, now } = eventRun(i * 5, [['oom', 'oom.kills', s]]); processPoll(state, host, res, cfg, now); });
  assert.equal(state.pending.length, 0);
});

test('overrideFor: exact key over instance over module; invalid override keys are rejected', () => {
  const cfg = { overrides: { 'sqlite-query': { confirm_runs: 3 }, 'sqlite-query/a': { confirm_runs: 2 }, 'sqlite-query/a.b': { confirm_runs: 1 } } };
  assert.equal(overrideFor(cfg, 'sqlite-query', 'a.b').confirm_runs, 1);
  assert.equal(overrideFor(cfg, 'sqlite-query', 'a.c').confirm_runs, 2);
  assert.equal(overrideFor(cfg, 'sqlite-query', 'z').confirm_runs, 3);
  assert.deepEqual(overrideFor(cfg, 'disk', 'root'), {});
  for (const bad of ['a/b/c', 'x y', '/lead']) {
    assert.throws(() => validateCollectConfig({ ...validRaw(), overrides: { [bad]: { confirm_runs: 1 } } }), /key must be a check name or check\/key/, bad);
  }
});
