// One run: all configured checks, one after another (kind to small hardware). A check that
// throws, hangs or returns something unusable is stored as `unknown` with a reason and does
// not affect any other check. Checks must work asynchronously without blocking — a
// synchronous busy loop cannot be interrupted within one process.
import { CHECKS } from './checks/index.js';
import { version as codeVersion } from './version.js';

const STATUSES = ['ok', 'warn', 'crit', 'unknown'];
const SUBKEY_PATTERN = /^[A-Za-z0-9_-]+$/;

// A state value must be storable as JSON. Otherwise state.set() throws inside the check — the
// check becomes `unknown` instead of the write transaction taking down the whole run.
export function validateStateValue(k, value) {
  if (typeof k !== 'string' || !SUBKEY_PATTERN.test(k)) throw new Error(`state key "${k}" is invalid`);
  let text;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    throw new Error(`state "${k}" cannot be stored as JSON: ${e.message}`);
  }
  if (text === undefined) throw new Error(`state "${k}" cannot be stored as JSON (${typeof value})`);
  return JSON.parse(text);
}

function unknown(entry, time, reason) {
  return { time, check: entry.check, key: entry.key, value: null, unit: null, status: 'unknown', reason };
}

// Validates a check result; anything invalid becomes `unknown` instead of an invented value.
export function normalize(entry, raw, time) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return [unknown(entry, time, 'check returned no measurements')];
  return list.map((m) => {
    const sub = m?.key;
    const key = sub === undefined ? entry.key : `${entry.key}.${sub}`;
    const row = { time, check: entry.check, key, value: null, unit: m?.unit ?? null, status: 'unknown', reason: null };
    const invalid = (reason) => ({ ...row, unit: null, reason: `invalid result: ${reason}` });
    if (m === null || typeof m !== 'object') return invalid('not an object');
    if (sub !== undefined && !(typeof sub === 'string' && SUBKEY_PATTERN.test(sub))) {
      return { ...invalid('key must consist of A-Z a-z 0-9 _ -'), key: `${entry.key}.?` };
    }
    if (!STATUSES.includes(m.status)) return invalid(`status "${m.status}" is unknown`);
    if (m.unit !== undefined && typeof m.unit !== 'string') return invalid('unit is not a string');
    if (m.status === 'unknown') {
      return { ...row, reason: typeof m.reason === 'string' && m.reason ? m.reason : 'unknown reported without a reason' };
    }
    const valueOk = typeof m.value === 'string' || (typeof m.value === 'number' && Number.isFinite(m.value));
    if (!valueOk) return invalid('value must be a finite number or a string');
    return { ...row, value: m.value, status: m.status, reason: typeof m.reason === 'string' ? m.reason : null };
  });
}

async function runCheck(entry, module, limitSeconds, store, now) {
  const ac = new AbortController();
  const pending = [];
  const ctx = {
    signal: ac.signal,
    state: {
      get: (k) => store.getState(entry.check, `${entry.key}/${k}`),
      set: (k, value) => {
        pending.push({ check: entry.check, key: `${entry.key}/${k}`, value: validateStateValue(k, value) });
      },
    },
  };
  let timer;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => module.measure(entry.params, ctx)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error(`timeout after ${limitSeconds} s`));
        }, limitSeconds * 1000);
      }),
    ]);
    // State only advances if the check completed normally.
    return { measurements: normalize(entry, raw, now().toISOString()), state: pending };
  } catch (e) {
    return { measurements: [unknown(entry, now().toISOString(), e?.message ? `check failed: ${e.message}` : 'check failed')], state: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function runOnce(config, store, { now = () => new Date(), version = codeVersion(), checks = CHECKS } = {}) {
  const startedAt = now();
  const measurements = [];
  const state = [];
  for (const entry of config.checks) {
    const r = await runCheck(entry, checks[entry.check], entry.timeout_seconds ?? config.timeout_seconds, store, now);
    measurements.push(...r.measurements);
    state.push(...r.state);
  }
  const finishedAt = now();
  const runId = store.saveRun({
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    version,
    intervalMinutes: config.interval_minutes,
    measurements,
    state,
  });
  store.pruneIfDue(config.retention_days, finishedAt);
  return { runId, durationMs: finishedAt - startedAt, measurements };
}
