import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../lib/config.js';
import { CHECKS } from '../lib/checks/index.js';
import { createMemoryCheck } from '../lib/checks/memory.js';
import { createLoadCheck } from '../lib/checks/load.js';
import { createDiskCheck } from '../lib/checks/disk.js';
import { createBootCheck, DEFAULT_MARKER_PATH } from '../lib/checks/boot.js';
import { createOomCheck } from '../lib/checks/oom.js';
import { createSystemdCheck } from '../lib/checks/systemd.js';
import { createMountCheck } from '../lib/checks/mount.js';
import { keyFrom } from '../lib/checks/util.js';

// All sources are injected: no test reads /proc or runs a system command.
const ok = (stdout, extra = {}) => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false, ...extra });
const by = (results) => Object.fromEntries(results.map((r) => [r.key, r]));
const memText = ({ total = 1000, avail = 500, swapTotal = 1000, swapFree = 900 } = {}) =>
  [`MemTotal:       ${total} kB`, `MemFree:        100 kB`, ...(avail === null ? [] : [`MemAvailable:   ${avail} kB`]),
    ...(swapTotal === null ? [] : [`SwapTotal:      ${swapTotal} kB`, `SwapFree:       ${swapFree} kB`])].join('\n');

// ---------- memory ----------
const memory = (text, params = {}) => createMemoryCheck({ readMeminfo: async () => text }).measure(params, {}).then(by);

test('memory: ok / warn / crit for RAM and swap from fixed /proc/meminfo text', async () => {
  let r = await memory(memText({ avail: 500, swapFree: 900 }));
  assert.deepEqual([r.ram.value, r.ram.status, r.swap.value, r.swap.status], [50, 'ok', 10, 'ok']);
  r = await memory(memText({ avail: 80, swapFree: 400 }));
  assert.deepEqual([r.ram.value, r.ram.status, r.swap.value, r.swap.status], [92, 'warn', 60, 'warn']);
  r = await memory(memText({ avail: 20, swapFree: 100 }));
  assert.deepEqual([r.ram.status, r.swap.status], ['crit', 'crit']);
  r = await memory(memText({ avail: 300 }), { ram_warn_percent: 60, ram_crit_percent: 70 });
  assert.equal(r.ram.status, 'crit');
});

test('memory: no swap configured is a measured 0 with a reason', async () => {
  const r = await memory(memText({ swapTotal: 0, swapFree: 0 }));
  assert.equal(r.swap.value, 0);
  assert.equal(r.swap.status, 'ok');
  assert.match(r.swap.reason, /no swap/);
});

test('memory: missing MemAvailable or swap lines is unknown with a reason, never 0', async () => {
  const r = await memory(memText({ avail: null, swapTotal: null }));
  assert.equal(r.ram.status, 'unknown');
  assert.match(r.ram.reason, /MemAvailable/);
  assert.equal(r.swap.status, 'unknown');
  assert.equal(r.ram.value, undefined);
  const g = await memory('garbage');
  assert.equal(g.ram.status, 'unknown');
  assert.equal(g.swap.status, 'unknown');
});

test('memory: unreadable source is unknown for both values', async () => {
  const c = createMemoryCheck({ readMeminfo: async () => { throw new Error('EACCES'); } });
  const r = by(await c.measure({}, {}));
  assert.deepEqual([r.ram.status, r.swap.status], ['unknown', 'unknown']);
  assert.match(r.ram.reason, /EACCES/);
});

// ---------- load ----------
const load = (text, cores, params = {}) =>
  createLoadCheck({ readLoadavg: async () => text, cores: () => cores }).measure(params, {}).then(by);

test('load: ratio to cores, thresholds apply to load5 and load15 only', async () => {
  let r = await load('0.50 0.40 0.30 1/200 999\n', 2);
  assert.deepEqual([r.load1.value, r.load5.value, r.load15.value], [0.25, 0.2, 0.15]);
  assert.equal(r.load5.status, 'ok');
  r = await load('9.00 3.20 1.00 1/200 999\n', 2);
  assert.equal(r.load1.status, 'ok');
  assert.equal(r.load5.status, 'warn'); // 1.6 per core
  assert.equal(r.load15.status, 'ok');
  r = await load('1.00 7.00 1.00 1/200 999\n', 2);
  assert.equal(r.load5.status, 'crit'); // 3.5 per core
});

test('load: broken source or unknown core count is unknown', async () => {
  let r = await load('nonsense', 2);
  assert.equal(r.load5.status, 'unknown');
  r = await load('1 1 1 1/1 1\n', 0);
  assert.equal(r.load5.status, 'unknown');
  const c = createLoadCheck({ readLoadavg: async () => { throw new Error('gone'); }, cores: () => 2 });
  assert.equal(by(await c.measure({}, {})).load1.status, 'unknown');
});

// ---------- disk ----------
const dfOut = (used, avail) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1000 ${used} ${avail} 50% /\n`;
const disk = (responses, params) =>
  createDiskCheck({ df: async (path) => responses[path] }).measure({ mounts: Object.keys(responses), ...params }, {}).then(by);

test('disk: percent per mount point as df computes it, ok / warn / crit', async () => {
  const r = await disk({ '/': ok(dfOut(400, 600)), '/var/data': ok(dfOut(870, 130)), '/mnt/big': ok(dfOut(960, 40)) });
  assert.deepEqual([r.root.value, r.root.status], [40, 'ok']);
  assert.deepEqual([r.var_data.value, r.var_data.status], [87, 'warn']);
  assert.deepEqual([r.mnt_big.value, r.mnt_big.status], [96, 'crit']);
});

test('disk: empty, unexpected or failing df output is unknown with a reason', async () => {
  const r = await disk({
    '/a': ok(''),
    '/b': ok('Filesystem 1024-blocks Used Available Capacity Mounted on\n'),
    '/c': ok('Filesystem x\n/dev/x abc def ghi 5% /\n'),
    '/d': ok('Filesystem x\n/dev/x 0 0 0 0% /\n'),
    '/e': { code: 1, stdout: '', stderr: "df: '/e': No such file or directory", timedOut: false },
    '/f': { code: null, stdout: '', stderr: '', timedOut: true },
    '/g': { code: null, stdout: '', stderr: '', spawnError: new Error('ENOENT') },
  });
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    assert.equal(r[k].status, 'unknown', k);
    assert.equal(r[k].value, undefined, k);
    assert.ok(r[k].reason, k);
  }
  assert.match(r.e.reason, /No such file/);
});

test('disk: validation rejects relative paths, empty lists and colliding keys', () => {
  const v = createDiskCheck().validate;
  assert.deepEqual(v({ mounts: ['/', '/var'] }), []);
  assert.ok(v({ mounts: [] }).length);
  assert.ok(v({ mounts: ['rel'] }).length);
  assert.ok(v({ mounts: ['/a_b', '/a/b'] }).length);
  assert.ok(v({ mounts: ['/'], warn_percent: 99, crit_percent: 90 }).length);
});

// ---------- oom ----------
const entry = (cursor, message) => JSON.stringify({ __CURSOR: cursor, MESSAGE: message });
const journalOut = (...e) => `${e.join('\n')}\n`;
const stateOf = (init = {}) => {
  const data = { ...init };
  return { data, ctx: { state: { get: (k) => data[k], set: (k, v) => { data[k] = v; } } } };
};

test('oom: first run counts kills since boot and stores the cursor', async () => {
  const seen = [];
  const c = createOomCheck({
    journal: async (args) => {
      seen.push(args);
      return ok(journalOut(
        entry('c1', 'Out of memory: Killed process 10 (java) total-vm:1kB'),
        entry('c2', 'oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null)'),
        entry('c3', 'Memory cgroup out of memory: Killed process 11 (node) total-vm:1kB'),
        entry('c4', 'usb 1-1: new device'),
      ));
    },
  });
  const { data, ctx } = stateOf();
  const [r] = await c.measure({}, ctx);
  assert.deepEqual([r.key, r.value, r.status], ['kills', 2, 'crit']);
  assert.equal(data.cursor, 'c4');
  assert.ok(seen[0].includes('-b'));
  assert.ok(!seen[0].includes('--after-cursor'));
});

test('oom: later run uses the cursor; nothing new is ok and keeps the cursor', async () => {
  let args;
  const c = createOomCheck({ journal: async (a) => { args = a; return ok(''); } });
  const { data, ctx } = stateOf({ cursor: 'c4' });
  const [r] = await c.measure({ severity: 'warn' }, ctx);
  assert.deepEqual([r.value, r.status], [0, 'ok']);
  assert.equal(data.cursor, 'c4');
  assert.deepEqual(args.slice(args.indexOf('--after-cursor')), ['--after-cursor', 'c4']);
  const c2 = createOomCheck({ journal: async () => ok(journalOut(entry('c9', 'Out of memory: Killed process 1 (x) y'))) });
  assert.equal((await c2.measure({ severity: 'warn' }, ctx))[0].status, 'warn');
  assert.equal(data.cursor, 'c9');
});

test('oom: unreadable journal is unknown and the cursor stays unchanged', async () => {
  const cases = [
    ok('', { stderr: 'Hint: You are currently not seeing messages from other users and the system.' }),
    { code: 1, stdout: '', stderr: 'Failed to get journal', timedOut: false },
    { code: null, stdout: '', stderr: '', spawnError: new Error('ENOENT') },
    ok('not json\n'),
    { code: null, stdout: '', stderr: '', timedOut: true },
  ];
  for (const res of cases) {
    const { data, ctx } = stateOf({ cursor: 'keep' });
    const [r] = await createOomCheck({ journal: async () => res }).measure({}, ctx);
    assert.equal(r.status, 'unknown');
    assert.ok(r.reason);
    assert.equal(data.cursor, 'keep');
  }
});

test('oom: first run with an empty journal is unknown, not "0 kills"', async () => {
  const { data, ctx } = stateOf();
  const [r] = await createOomCheck({ journal: async () => ok('') }).measure({}, ctx);
  assert.equal(r.status, 'unknown');
  assert.equal(data.cursor, undefined);
});

// ---------- boot ----------
const OLD_ID = '5103a8e6-5871-4029-8676-23ca264f6b37';
const NEW_ID = 'b53796cf-6d93-4f43-a2d6-4c8ff3a1e001';
const jl = (msg, ident = 'systemd', us = '1790130434000000') => JSON.stringify({ MESSAGE: msg, SYSLOG_IDENTIFIER: ident, __REALTIME_TIMESTAMP: us });
const BOOT_NOW = Date.UTC(2026, 8, 27, 4, 30, 0);
const bootCheck = (over = {}) => createBootCheck({ readBootId: async () => `${NEW_ID}\n`, journal: async () => ok(''), now: () => BOOT_NOW, uptime: () => 120, ...over });

test('boot: first run stores the boot ID as baseline, ok and no event', async () => {
  const { data, ctx } = stateOf();
  const [r] = await bootCheck().measure({}, ctx);
  assert.deepEqual([r.key, r.value, r.status], ['reboots', 0, 'ok']);
  assert.match(r.reason, /baseline/);
  assert.equal(data.boot_id, NEW_ID);
});

test('boot: unchanged boot ID is ok with value 0 and does not read the journal', async () => {
  const { ctx } = stateOf({ boot_id: NEW_ID });
  const [r] = await bootCheck({ journal: async () => { throw new Error('must not be called'); } }).measure({}, ctx);
  assert.deepEqual([r.value, r.status, r.reason], [0, 'ok', undefined]);
});

test('boot: changed boot ID after an orderly shutdown is warn "clean"', async () => {
  let args;
  const out = [jl('Stopping foo'), jl('Reached target reboot.target - System Reboot.'), jl('Shutting down.', 'systemd', '1790130434257126')].join('\n');
  const { data, ctx } = stateOf({ boot_id: OLD_ID });
  const [r] = await bootCheck({ journal: async (a) => { args = a; return ok(out); } }).measure({}, ctx);
  assert.deepEqual([r.value, r.status], [1, 'warn']);
  assert.match(r.reason, /previous boot ended clean/);
  assert.match(r.reason, /booted at 2026-09-27T04:28:00Z/);
  assert.match(r.reason, /last entry 2026-09-23T02:27:14Z/);
  assert.equal(data.boot_id, NEW_ID);
  assert.equal(args.at(-1), `_BOOT_ID=${OLD_ID.replace(/-/g, '')}`); // a match, not -b: an all-digit ID would read as an offset
  assert.ok(!args.includes('-b'));
});

test('boot: changed boot ID without a shutdown in a readable journal is crit "unclean"', async () => {
  const { ctx } = stateOf({ boot_id: OLD_ID });
  const [r] = await bootCheck({ journal: async () => ok([jl('Started foo'), jl('Shutting down.', 'someone-else')].join('\n')) }).measure({}, ctx);
  assert.deepEqual([r.value, r.status], [1, 'crit']);
  assert.match(r.reason, /unclean/);
  const [w] = await bootCheck({ journal: async () => ok(jl('Started foo')) }).measure({ unclean_severity: 'warn' }, stateOf({ boot_id: OLD_ID }).ctx);
  assert.equal(w.status, 'warn');
});

test('boot: the event occurs once, the following run is ok again', async () => {
  const { ctx } = stateOf({ boot_id: OLD_ID });
  const c = bootCheck({ journal: async () => ok(jl('Shutting down.')) });
  assert.equal((await c.measure({}, ctx))[0].value, 1);
  assert.equal((await c.measure({}, ctx))[0].value, 0);
});

test('boot: journal of the previous boot not readable still reports the reboot, end unknown, never clean', async () => {
  const cases = [
    ok(''),
    ok('', { stderr: 'Hint: You are currently not seeing messages from other users and the system.' }),
    { code: 1, stdout: '', stderr: 'Data from the specified boot (x) is not available', timedOut: false },
    { code: null, stdout: '', stderr: '', spawnError: new Error('ENOENT') },
    { code: null, stdout: '', stderr: '', timedOut: true },
    ok('not json\n'),
  ];
  for (const res of cases) {
    const { data, ctx } = stateOf({ boot_id: OLD_ID });
    const [r] = await bootCheck({ journal: async () => res }).measure({ severity: 'crit' }, ctx);
    assert.deepEqual([r.value, r.status], [1, 'crit'], JSON.stringify(res));
    assert.match(r.reason, /previous boot end unknown: /);
    assert.doesNotMatch(r.reason, /ended clean/);
    assert.equal(data.boot_id, NEW_ID);
  }
  const [t] = await bootCheck({ journal: async () => { throw new Error('boom'); } }).measure({}, stateOf({ boot_id: OLD_ID }).ctx);
  assert.match(t.reason, /unknown: journalctl could not be run/);
});

test('boot: an invalid stored boot ID gives end unknown without calling the journal', async () => {
  const [r] = await bootCheck({ journal: async () => { throw new Error('no'); } }).measure({}, stateOf({ boot_id: '--; rm' }).ctx);
  assert.equal(r.value, 1);
  assert.match(r.reason, /unknown: stored boot ID is not valid/);
});

test('boot: unreadable boot ID is unknown and the stored ID stays unchanged', async () => {
  for (const readBootId of [async () => { throw new Error('ENOENT'); }, async () => '  \n']) {
    const { data, ctx } = stateOf({ boot_id: OLD_ID });
    const [r] = await bootCheck({ readBootId }).measure({}, ctx);
    assert.equal(r.status, 'unknown');
    assert.ok(r.reason);
    assert.equal(data.boot_id, OLD_ID);
  }
});

test('boot: severity parameters are validated', () => {
  const c = bootCheck();
  assert.deepEqual(c.validate({ severity: 'crit', unclean_severity: 'warn' }), []);
  assert.equal(c.validate({ severity: 'x', unclean_severity: 'y' }).length, 2);
});

test('boot: expected_marker / expected_max_age_minutes are validated', () => {
  const c = bootCheck();
  assert.deepEqual(c.validate({ expected_marker: '/var/lib/skopos/x.json', expected_max_age_minutes: 15 }), []);
  assert.equal(c.validate({ expected_marker: 'relative.json' }).length, 1);
  assert.equal(c.validate({ expected_max_age_minutes: 0 }).length, 1);
  assert.equal(c.validate({ expected_max_age_minutes: 'x' }).length, 1);
});

// A fake marker "store": readMarker resolves what marker() last set, removeMarker records calls
// and clears it — close enough to a one-shot file to exercise the check without touching disk.
const markerOf = (initial) => {
  let current = initial ?? null;
  const removed = [];
  return {
    readMarker: async () => current,
    removeMarker: async (path) => { removed.push(path); current = null; },
    removed,
    set: (m) => { current = m; },
  };
};
const CLEAN_OUT = [jl('Stopping foo'), jl('Reached target reboot.target - System Reboot.'), jl('Shutting down.', 'systemd', '1790130434257126')].join('\n');

test('boot: a fresh marker downgrades a clean reboot to ok and is consumed', async () => {
  const m = markerOf({ createdAt: BOOT_NOW - 5 * 60000, reason: 'planned kernel update' });
  const { data, ctx } = stateOf({ boot_id: OLD_ID });
  const [r] = await bootCheck({ journal: async () => ok(CLEAN_OUT), ...m }).measure({}, ctx);
  assert.deepEqual([r.value, r.status], [1, 'ok']);
  assert.match(r.reason, /expected reboot \(planned kernel update\)/);
  assert.equal(data.boot_id, NEW_ID);
  assert.deepEqual(m.removed, [DEFAULT_MARKER_PATH]);
});

test('boot: a marker without a reason still downgrades, with a plain note', async () => {
  const m = markerOf({ createdAt: BOOT_NOW - 60000 });
  const [r] = await bootCheck({ journal: async () => ok(CLEAN_OUT), ...m }).measure({}, stateOf({ boot_id: OLD_ID }).ctx);
  assert.equal(r.status, 'ok');
  assert.match(r.reason, /; expected reboot$/);
});

test('boot: a marker never downgrades an unclean end, but is still consumed', async () => {
  const m = markerOf({ createdAt: BOOT_NOW - 60000, reason: 'planned' });
  const [r] = await bootCheck({ journal: async () => ok(jl('Started foo')), ...m }).measure({}, stateOf({ boot_id: OLD_ID }).ctx);
  assert.equal(r.status, 'crit');
  assert.doesNotMatch(r.reason, /expected reboot/);
  assert.equal(m.removed.length, 1);
});

test('boot: a stale marker is ignored and removed, does not wait for a reboot to be cleaned up', async () => {
  const m = markerOf({ createdAt: BOOT_NOW - 31 * 60000, reason: 'too old' });
  // No reboot this run (boot ID unchanged) — the stale marker is still cleaned up right away.
  await bootCheck({ ...m }).measure({}, stateOf({ boot_id: NEW_ID }).ctx);
  assert.deepEqual(m.removed, [DEFAULT_MARKER_PATH]);
  m.set({ createdAt: BOOT_NOW - 31 * 60000, reason: 'too old' });
  const [r] = await bootCheck({ journal: async () => ok(CLEAN_OUT), ...m }).measure({}, stateOf({ boot_id: OLD_ID }).ctx);
  assert.equal(r.status, 'warn');
  assert.doesNotMatch(r.reason, /expected reboot/);
});

test('boot: expected_max_age_minutes narrows the freshness window', async () => {
  const m = markerOf({ createdAt: BOOT_NOW - 20 * 60000, reason: 'planned' });
  const [r] = await bootCheck({ journal: async () => ok(CLEAN_OUT), ...m }).measure({ expected_max_age_minutes: 10 }, stateOf({ boot_id: OLD_ID }).ctx);
  assert.equal(r.status, 'warn');
});

test('boot: an unreadable/invalid marker is treated as absent and removed, not as an error', async () => {
  const m = markerOf({ invalid: true });
  const [r] = await bootCheck({ journal: async () => ok(CLEAN_OUT), ...m }).measure({}, stateOf({ boot_id: OLD_ID }).ctx);
  assert.equal(r.status, 'warn');
  assert.equal(m.removed.length, 1);
});

test('boot: no marker at all behaves exactly as before', async () => {
  const m = markerOf(null);
  const [r] = await bootCheck({ journal: async () => ok(CLEAN_OUT), ...m }).measure({}, stateOf({ boot_id: OLD_ID }).ctx);
  assert.equal(r.status, 'warn');
  assert.equal(m.removed.length, 0);
});

// ---------- systemd ----------
const show = (map) => async (unit) => map[unit] ?? { code: 1, stdout: '', stderr: 'boom', timedOut: false };
const sd = (map, units) => createSystemdCheck({ show: show(map) }).measure({ units }, {}).then(by);
const props = (active, load = 'loaded') => ok(`LoadState=${load}\nActiveState=${active}\n`);

test('systemd: state against expectation, severity from the config', async () => {
  const r = await sd(
    { 'a.service': props('active'), 'b.service': props('inactive'), 'c.service': props('failed'), 'd.service': props('inactive'),
      'e.service': props('active'), 'f.service': props('activating') },
    [{ unit: 'a.service' }, { unit: 'b.service', severity: 'warn' }, { unit: 'c.service' }, { unit: 'd.service', expected: 'inactive' },
      { unit: 'e.service', expected: 'inactive', severity: 'warn' }, { unit: 'f.service' }],
  );
  assert.deepEqual([r.a_service.status, r.a_service.value], ['ok', 'active']);
  assert.equal(r.b_service.status, 'warn');
  assert.equal(r.c_service.status, 'crit');
  assert.equal(r.d_service.status, 'ok');
  assert.equal(r.e_service.status, 'warn');
  assert.equal(r.f_service.status, 'warn'); // transitional
  assert.match(r.c_service.reason, /failed/);
});

test('systemd: unknown unit, missing systemctl and odd states are unknown with a reason', async () => {
  const r = await sd(
    { 'gone.service': props('inactive', 'not-found'), 'odd.service': props('confused'), 'empty.service': ok('') },
    [{ unit: 'gone.service' }, { unit: 'odd.service' }, { unit: 'empty.service' }, { unit: 'fail.service' }],
  );
  for (const k of ['gone_service', 'odd_service', 'empty_service', 'fail_service']) {
    assert.equal(r[k].status, 'unknown', k);
    assert.equal(r[k].value, undefined, k);
  }
  assert.match(r.gone_service.reason, /not found/);
  const c = createSystemdCheck({ show: async () => ({ code: null, stdout: '', stderr: '', spawnError: new Error('ENOENT') }) });
  assert.match(by(await c.measure({ units: [{ unit: 'x.service' }] }, {})).x_service.reason, /could not be started/);
});

test('systemd: validation', () => {
  const v = createSystemdCheck().validate;
  assert.deepEqual(v({ units: [{ unit: 'a.service', expected: 'inactive', severity: 'warn' }] }), []);
  assert.ok(v({ units: [] }).length);
  assert.ok(v({ units: [{ unit: 'a.service', expected: 'running' }] }).length);
  assert.ok(v({ units: [{ unit: 'a.service', extra: 1 }] }).length);
  assert.ok(v({ units: [{ severity: 'warn' }] }).length);
});

// Controlled restart: NOW is the monotonic clock in µs, `changed` the seconds since the state change.
const NOW = 1_000_000_000_000n;
const restartProps = (active, { result = 'success', sub = 'dead', changed = 10, load = 'loaded' } = {}) => ok(
  [`LoadState=${load}`, `ActiveState=${active}`, `SubState=${sub}`,
    ...(result === null ? [] : [`Result=${result}`]),
    ...(changed === null ? [] : [`StateChangeTimestampMonotonic=${typeof changed === 'string' ? changed : NOW - BigInt(changed * 1e6)}`])].join('\n'));
const sdGrace = (map, units, params = {}) =>
  createSystemdCheck({ show: show(map), now: () => NOW }).measure({ units, ...params }, {}).then(by);

test('systemd: clean stop/start within the grace period is ok with the real state and a reason', async () => {
  const r = await sdGrace(
    { 'a.service': restartProps('deactivating', { sub: 'stop-sigterm', changed: 17 }),
      'b.service': restartProps('activating', { sub: 'start' }), 'c.service': restartProps('inactive', { changed: 120 }) },
    [{ unit: 'a.service' }, { unit: 'b.service' }, { unit: 'c.service' }], { restart_grace_seconds: 120 },
  );
  assert.deepEqual([r.a_service.status, r.a_service.value], ['ok', 'deactivating']);
  assert.match(r.a_service.reason, /controlled restart tolerated \(deactivating, 17 s\)/);
  assert.deepEqual([r.b_service.status, r.b_service.value], ['ok', 'activating']);
  assert.deepEqual([r.c_service.status, r.c_service.value], ['ok', 'inactive']);
});

test('systemd: after the grace period the old rating applies (transitional warn, inactive severity)', async () => {
  const r = await sdGrace(
    { 'a.service': restartProps('deactivating', { changed: 121 }), 'b.service': restartProps('inactive', { changed: 600 }) },
    [{ unit: 'a.service' }, { unit: 'b.service', severity: 'warn' }], { restart_grace_seconds: 120 },
  );
  assert.equal(r.a_service.status, 'warn');
  assert.equal(r.b_service.status, 'warn');
  const s = await sdGrace({ 'b.service': restartProps('inactive', { changed: 600 }) }, [{ unit: 'b.service' }], { restart_grace_seconds: 120 });
  assert.equal(s.b_service.status, 'crit');
});

test('systemd: crashes, auto-restart and failed are never tolerated', async () => {
  const map = {
    'exit.service': restartProps('inactive', { result: 'exit-code' }),
    'sig.service': restartProps('deactivating', { result: 'signal' }),
    'oom.service': restartProps('inactive', { result: 'oom-kill' }),
    'tmo.service': restartProps('deactivating', { result: 'timeout' }),
    'auto.service': restartProps('activating', { sub: 'auto-restart' }),
    'failed.service': restartProps('failed'),
  };
  const r = await sdGrace(map, Object.keys(map).map((unit) => ({ unit })), { restart_grace_seconds: 120 });
  assert.equal(r.exit_service.status, 'crit');
  assert.equal(r.sig_service.status, 'warn');
  assert.equal(r.oom_service.status, 'crit');
  assert.equal(r.tmo_service.status, 'warn');
  assert.equal(r.auto_service.status, 'warn');
  assert.equal(r.failed_service.status, 'crit');
  for (const x of Object.values(r)) assert.doesNotMatch(x.reason, /tolerated/);
});

test('systemd: missing or unreadable Result or timestamp falls back to the old rating', async () => {
  const map = {
    'nores.service': restartProps('inactive', { result: null }),
    'nots.service': restartProps('deactivating', { changed: null }),
    'zero.service': restartProps('inactive', { changed: '0' }),
    'text.service': restartProps('inactive', { changed: 'n/a' }),
    'future.service': restartProps('activating', { changed: String(NOW + 5_000_000n) }),
  };
  const r = await sdGrace(map, Object.keys(map).map((unit) => ({ unit })), { restart_grace_seconds: 120 });
  assert.deepEqual(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status])),
    { nores_service: 'crit', nots_service: 'warn', zero_service: 'crit', text_service: 'crit', future_service: 'warn' });
});

test('systemd: default 0 keeps the old behaviour; per-unit value overrides the list; expected inactive untouched', async () => {
  const map = { 'a.service': restartProps('deactivating'), 'b.service': restartProps('inactive'), 'c.service': restartProps('activating') };
  let r = await sdGrace(map, [{ unit: 'a.service' }, { unit: 'b.service' }]);
  assert.deepEqual([r.a_service.status, r.b_service.status], ['warn', 'crit']);
  r = await sdGrace(map, [{ unit: 'a.service', restart_grace_seconds: 0 }, { unit: 'b.service', restart_grace_seconds: 60 }],
    { restart_grace_seconds: 120 });
  assert.deepEqual([r.a_service.status, r.b_service.status], ['warn', 'ok']);
  r = await sdGrace(map, [{ unit: 'c.service', expected: 'inactive' }], { restart_grace_seconds: 120 });
  assert.equal(r.c_service.status, 'warn');
});

test('systemd: restart_grace_seconds validation', () => {
  const v = createSystemdCheck().validate;
  assert.deepEqual(v({ units: [{ unit: 'a.service', restart_grace_seconds: 30 }], restart_grace_seconds: 120 }), []);
  assert.deepEqual(v({ units: [{ unit: 'a.service' }], restart_grace_seconds: 0 }), []);
  for (const bad of [-1, '120', null, Infinity, NaN, true]) {
    assert.ok(v({ units: [{ unit: 'a.service' }], restart_grace_seconds: bad }).length, `list ${bad}`);
    assert.ok(v({ units: [{ unit: 'a.service', restart_grace_seconds: bad }] }).length, `unit ${bad}`);
  }
  const cfg = (extra) => validateConfig({ checks: [{ check: 'systemd', key: 'svc', units: [{ unit: 'a.service' }], ...extra }] }, CHECKS);
  assert.doesNotThrow(() => cfg({ restart_grace_seconds: 120 }));
  assert.throws(() => cfg({ restart_grace_seconds: 'x' }), /restart_grace_seconds/);
});

// ---------- mount ----------
const mountinfo = '36 35 98:0 / /mnt/data rw - ext4 /dev/x rw\n40 35 0:31 / /mnt/with\\040space rw - fuse.rclone r rw\n';
const mount = (paths, probe, params = {}) =>
  createMountCheck({ readMountinfo: async () => mountinfo, probe }).measure({ paths, ...params }, {}).then(by);

test('mount: mounted and readable is ok with the duration; not mounted is crit', async () => {
  const r = await mount(['/mnt/data', '/mnt/other', '/mnt/with space'], () => ({ cmd: 'true', args: [] }));
  assert.equal(r.mnt_data.status, 'ok');
  assert.equal(r.mnt_data.unit, 'ms');
  assert.equal(r.mnt_with_space.status, 'ok');
  assert.equal(r.mnt_other.status, 'crit');
  assert.match(r.mnt_other.reason, /not mounted/);
});

test('mount: unreadable mount is crit with the error, unreadable mountinfo is unknown', async () => {
  const r = await mount(['/mnt/data'], () => ({ cmd: 'sh', args: ['-c', 'echo denied >&2; exit 2'] }));
  assert.equal(r.mnt_data.status, 'crit');
  assert.match(r.mnt_data.reason, /denied/);
  const c = createMountCheck({ readMountinfo: async () => { throw new Error('nope'); }, probe: () => ({ cmd: 'true', args: [] }) });
  assert.equal(by(await c.measure({ paths: ['/mnt/data'] }, {})).mnt_data.status, 'unknown');
});

test('mount: a hanging mount ends after the timeout, the child is killed, others are unaffected', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skopos-mount-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const probe = (path) => (path === '/mnt/data'
    ? { cmd: 'sh', args: ['-c', `echo $$ > ${pidFile}; exec sleep 60`] }
    : { cmd: 'true', args: [] });
  const t0 = Date.now();
  const r = await mount(['/mnt/data', '/mnt/with space'], probe, { read_timeout_seconds: 0.5 });
  assert.ok(Date.now() - t0 < 5000, 'ended long before the child would have');
  assert.equal(r.mnt_data.status, 'crit');
  assert.match(r.mnt_data.reason, /mount does not respond/);
  assert.equal(r.mnt_with_space.status, 'ok');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'child process is gone');
});

test('mount: an abort of the check kills the child as well', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skopos-mount-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const ac = new AbortController();
  const c = createMountCheck({ readMountinfo: async () => mountinfo, probe: () => ({ cmd: 'sh', args: ['-c', `echo $$ > ${pidFile}; exec sleep 60`] }) });
  const p = c.measure({ paths: ['/mnt/data'] }, { signal: ac.signal });
  while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) await new Promise((res) => setTimeout(res, 20));
  ac.abort();
  const [r] = await p;
  assert.equal(r.status, 'unknown');
  assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
});

test('systemd: boot_grace_seconds tolerates activating/inactive shortly after the boot, never failed', async () => {
  const map = { 'a.service': props('activating'), 'b.service': props('inactive'), 'c.service': props('failed'), 'd.service': props('inactive') };
  const units = [{ unit: 'a.service' }, { unit: 'b.service' }, { unit: 'c.service' }, { unit: 'd.service', expected: 'inactive' }];
  const run = (uptime, params) => createSystemdCheck({ show: show(map), uptime: () => uptime }).measure({ units, ...params }, {}).then(by);
  let r = await run(90, { boot_grace_seconds: 600 });
  assert.deepEqual([r.a_service.status, r.b_service.status, r.c_service.status, r.d_service.status], ['ok', 'ok', 'crit', 'ok']);
  assert.equal(r.a_service.value, 'activating');
  assert.match(r.a_service.reason, /within boot grace/);
  r = await run(600, { boot_grace_seconds: 600 });
  assert.deepEqual([r.a_service.status, r.b_service.status, r.c_service.status], ['warn', 'crit', 'crit']);
  r = await run(90, {});
  assert.deepEqual([r.a_service.status, r.b_service.status], ['warn', 'crit']);
  r = await run(90, { boot_grace_seconds: 0 });
  assert.equal(r.b_service.status, 'crit');
});

test('systemd: boot_grace_seconds is validated', () => {
  const c = createSystemdCheck({ show: show({}) });
  assert.deepEqual(c.validate({ units: [{ unit: 'a.service' }], boot_grace_seconds: 600 }), []);
  assert.ok(c.validate({ units: [{ unit: 'a.service' }], boot_grace_seconds: -1 }).length);
  assert.ok(c.validate({ units: [{ unit: 'a.service' }], boot_grace_seconds: 'x' }).length);
});

// ---------- registry and config ----------
test('all six checks are registered and accepted by the config validator', () => {
  for (const n of ['memory', 'load', 'disk', 'oom', 'systemd', 'mount']) assert.ok(CHECKS[n], n);
  const cfg = validateConfig({
    checks: [
      { check: 'memory', key: 'mem' }, { check: 'load', key: 'cpu' }, { check: 'disk', key: 'fs', mounts: ['/'] },
      { check: 'oom', key: 'oom' }, { check: 'systemd', key: 'svc', units: [{ unit: 'example.service' }] },
      { check: 'mount', key: 'mnt', paths: ['/mnt/example'], read_timeout_seconds: 3 },
    ],
  });
  assert.equal(cfg.checks.length, 6);
  assert.throws(() => validateConfig({ checks: [{ check: 'disk', key: 'fs', mounts: 'x' }] }), /mounts/);
  assert.throws(() => validateConfig({ checks: [{ check: 'memory', key: 'm', ram_warn_percent: 120 }] }), /ram_warn_percent/);
});

test('keyFrom', () => {
  assert.equal(keyFrom('/'), 'root');
  assert.equal(keyFrom('/var/lib/x'), 'var_lib_x');
  assert.equal(keyFrom('a.service'), 'a_service');
});

// ---------- follow-ups from the review ----------

test('oom: a rejected cursor falls back to counting since boot once, and says so', async () => {
  const seen = [];
  const c = createOomCheck({
    journal: async (args) => {
      seen.push(args);
      if (args.includes('--after-cursor')) return { code: 1, stdout: '', stderr: 'Failed to seek to cursor: Invalid argument', timedOut: false };
      return ok(journalOut(entry('b1', 'Out of memory: Killed process 5 (x) y'), entry('b2', 'usb: new device')));
    },
  });
  const { data, ctx } = stateOf({ cursor: 'garbage' });
  const [r] = await c.measure({}, ctx);
  assert.deepEqual([r.value, r.status], [1, 'crit']);
  assert.match(r.reason, /since boot/);
  assert.match(r.reason, /cursor was rejected/);
  assert.equal(data.cursor, 'b2', 'a fresh cursor replaces the rejected one');
  assert.deepEqual(seen.map((a) => a.includes('-b')), [false, true]);

  const quiet = createOomCheck({ journal: async (args) => (args.includes('--after-cursor')
    ? { code: 1, stdout: '', stderr: 'Failed to seek to cursor', timedOut: false }
    : ok(journalOut(entry('b3', 'usb: new device')))) });
  const q = stateOf({ cursor: 'garbage' });
  const [r2] = await quiet.measure({}, q.ctx);
  assert.deepEqual([r2.value, r2.status], [0, 'ok']);
  assert.match(r2.reason, /cursor was rejected/, 'the fallback is visible even when all is well');
});

test('paths must be in normal form: a trailing slash would never match a mount point', () => {
  const bad = ['/mnt/data/', '/mnt//data', '/mnt/./data', '/mnt/x/../data'];
  for (const p of bad) {
    for (const entry of [{ check: 'mount', key: 'm', paths: [p] }, { check: 'disk', key: 'd', mounts: [p] }]) {
      assert.throws(() => validateConfig({ checks: [entry] }), (e) => e.messages.some((m) => m.includes('must be written as')), `${entry.check} ${p}`);
    }
  }
  validateConfig({ checks: [{ check: 'mount', key: 'm', paths: ['/mnt/data'] }, { check: 'disk', key: 'd', mounts: ['/', '/mnt/data'] }] });
});
