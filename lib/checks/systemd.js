// Units against their expected state (active / inactive), via `systemctl show`.
// `show` (not `is-active`) because is-active reports a missing unit as "inactive".
// Optional grace period: a unit expected active that is briefly down after a clean stop
// (Result=success) is tolerated, so a controlled restart is not a finding. A second, separate
// grace period after the machine's boot tolerates units still starting (or not yet started).
import { uptime as osUptime } from 'node:os';
import { describeFailure, duplicateKeys, keyFrom, run, unknown } from './util.js';

const STATES = ['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'maintenance', 'refreshing'];
const TRANSITIONAL = ['activating', 'deactivating', 'reloading', 'refreshing'];
const UNIT_KEYS = ['unit', 'expected', 'severity', 'restart_grace_seconds'];
const PROPS = ['LoadState', 'ActiveState', 'SubState', 'Result', 'StateChangeTimestampMonotonic'];

const isGrace = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function parseShow(text) {
  const props = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return props;
}

const defaultShow = (unit, { signal }) =>
  run('systemctl', ['show', '--no-pager', ...PROPS.flatMap((p) => ['-p', p]), '--', unit], { signal, timeoutMs: 10000 });

// CLOCK_MONOTONIC in microseconds, the clock of StateChangeTimestampMonotonic (libuv uses it on Linux).
const defaultNow = () => process.hrtime.bigint() / 1000n;

// Seconds since the last state change, or null if it cannot be determined.
export function secondsSinceChange(props, nowMicros) {
  const t = props.StateChangeTimestampMonotonic;
  if (typeof t !== 'string' || !/^[0-9]+$/.test(t) || t === '0') return null;
  const diff = BigInt(nowMicros) - BigInt(t);
  return diff < 0n ? null : Number(diff) / 1e6;
}

// A clean stop or start of a unit expected active, still within the grace period.
function tolerated(props, state, grace, nowMicros) {
  if (!(grace > 0)) return null;
  if (!TRANSITIONAL.includes(state) && state !== 'inactive') return null;
  if (props.Result !== 'success' || props.SubState === 'auto-restart') return null;
  const age = secondsSinceChange(props, nowMicros);
  if (age === null || age > grace) return null;
  return Math.round(age);
}

// A unit expected active that is still starting or not yet started shortly after the boot.
// `failed` is never tolerated.
const bootTolerated = (state, sinceBoot, grace) => grace > 0 && sinceBoot < grace && (state === 'activating' || state === 'inactive');

export function createSystemdCheck({ show = defaultShow, now = defaultNow, uptime = osUptime } = {}) {
  return {
    name: 'systemd',
    required: ['units'],
    optional: ['restart_grace_seconds', 'boot_grace_seconds'],
    validate(params) {
      const u = params.units;
      if (!Array.isArray(u) || u.length === 0) return ['units must be a non-empty list'];
      const errors = [];
      if (params.restart_grace_seconds !== undefined && !isGrace(params.restart_grace_seconds)) {
        errors.push('restart_grace_seconds must be a number >= 0');
      }
      if (params.boot_grace_seconds !== undefined && !isGrace(params.boot_grace_seconds)) {
        errors.push('boot_grace_seconds must be a number >= 0');
      }
      u.forEach((e, i) => {
        const where = `units[${i}]`;
        if (e === null || typeof e !== 'object' || Array.isArray(e)) return errors.push(`${where} must be an object`);
        for (const k of Object.keys(e)) if (!UNIT_KEYS.includes(k)) errors.push(`${where}: unknown key "${k}"`);
        if (typeof e.unit !== 'string' || !/^[A-Za-z0-9:_.\\@-]+$/.test(e.unit)) errors.push(`${where}: unit is missing or invalid`);
        if (e.expected !== undefined && !['active', 'inactive'].includes(e.expected)) errors.push(`${where}: expected must be "active" or "inactive"`);
        if (e.severity !== undefined && !['warn', 'crit'].includes(e.severity)) errors.push(`${where}: severity must be "warn" or "crit"`);
        if (e.restart_grace_seconds !== undefined && !isGrace(e.restart_grace_seconds)) errors.push(`${where}: restart_grace_seconds must be a number >= 0`);
      });
      if (!errors.length) errors.push(...duplicateKeys(u.map((e) => e.unit)));
      return errors;
    },
    async measure(params, ctx) {
      const out = [];
      const listGrace = params.restart_grace_seconds ?? 0;
      const bootGrace = params.boot_grace_seconds ?? 0;
      const sinceBoot = bootGrace > 0 ? uptime() : Infinity;
      for (const { unit, expected = 'active', severity = 'crit', restart_grace_seconds: grace = listGrace } of params.units) {
        const key = keyFrom(unit);
        const r = await show(unit, { signal: ctx?.signal });
        if (r.spawnError || r.timedOut || r.aborted || r.code !== 0) {
          out.push(unknown(key, `${unit}: ${describeFailure('systemctl', r)}`));
          continue;
        }
        const p = parseShow(r.stdout);
        if (p.LoadState === 'not-found') {
          out.push(unknown(key, `${unit}: unit not found`));
          continue;
        }
        const state = p.ActiveState;
        if (!STATES.includes(state)) {
          out.push(unknown(key, `${unit}: unexpected state "${state ?? ''}"`));
          continue;
        }
        const age = expected === 'active' ? tolerated(p, state, grace, now()) : null;
        if (state === expected) {
          out.push({ key, value: state, status: 'ok' });
        } else if (age !== null) {
          out.push({ key, value: state, status: 'ok', reason: `${unit}: controlled restart tolerated (${state}, ${age} s)` });
        } else if (expected === 'active' && bootTolerated(state, sinceBoot, bootGrace)) {
          out.push({ key, value: state, status: 'ok', reason: `${unit}: ${state}, within boot grace (${Math.floor(sinceBoot)} s since boot)` });
        } else if (TRANSITIONAL.includes(state)) {
          out.push({ key, value: state, status: 'warn', reason: `${unit} is ${state} (expected ${expected})` });
        } else {
          out.push({ key, value: state, status: severity, reason: `${unit} is ${state}, expected ${expected}` });
        }
      }
      return out;
    },
  };
}

export default createSystemdCheck();
