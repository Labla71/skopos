// Shared helpers of the system checks: threshold evaluation, key derivation, and a child
// process runner that always ends (SIGKILL on timeout or abort).
import { spawn } from 'node:child_process';
import { posix } from 'node:path';

export const isNumber = (x) => typeof x === 'number' && Number.isFinite(x);
export const round1 = (x) => Math.round(x * 10) / 10;

// Validates an optional numeric parameter `name` ≥ min; returns error messages.
export function checkNumber(params, name, { min = 0, max = Infinity } = {}) {
  const v = params[name];
  if (v === undefined) return [];
  return isNumber(v) && v >= min && v <= max ? [] : [`${name} must be a number between ${min} and ${max}`];
}

// warn ≤ crit, if both are given.
export function checkOrder(params, warn, crit) {
  const w = params[warn];
  const c = params[crit];
  return isNumber(w) && isNumber(c) && w > c ? [`${warn} must not exceed ${crit}`] : [];
}

// ok / warn / crit for a value against "at or above" thresholds.
export function level(value, warn, crit) {
  if (crit !== undefined && value >= crit) return 'crit';
  if (warn !== undefined && value >= warn) return 'warn';
  return 'ok';
}

export const unknown = (key, reason) => ({ key, status: 'unknown', reason });

// Stable key part from a path or unit name: "/" -> "root", "/var/data" -> "var_data".
export function keyFrom(text) {
  if (text === '/') return 'root';
  const k = text.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return k || 'x';
}

// Validates a non-empty list of absolute paths in normal form. "/mnt/x/" or "/mnt//x" would
// never match a mount point exactly and produce a permanent false alarm, so they are rejected.
export function checkPaths(list, name) {
  if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === 'string' && p.startsWith('/'))) {
    return [`${name} must be a non-empty list of absolute paths`];
  }
  const errors = [];
  for (const p of list) {
    const normal = posix.normalize(p).replace(/(.)\/+$/, '$1');
    if (p !== normal) errors.push(`${name}: "${p}" must be written as "${normal}"`);
  }
  return errors.length ? errors : duplicateKeys(list);
}

// Rejects a list whose entries collapse to the same key.
export function duplicateKeys(names) {
  const seen = new Set();
  const errors = [];
  for (const n of names) {
    const k = keyFrom(n);
    if (seen.has(k)) errors.push(`"${n}" maps to the key "${k}" that is already used`);
    seen.add(k);
  }
  return errors;
}

// Runs a command and always resolves: { code, stdout, stderr, timedOut, aborted, spawnError }.
// After the timeout the child gets SIGKILL; the result does not wait longer than `graceMs`
// for it to actually end (a process in an uninterruptible kernel call may linger).
export function run(cmd, args, { timeoutMs = 10000, signal, maxBuffer = 16 * 1024 * 1024, graceMs = 1000, env } = {}) {
  return new Promise((resolve) => {
    const result = { code: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: undefined };
    let settled = false;
    let child;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    let grace;
    const kill = () => {
      child?.kill('SIGKILL');
      grace = setTimeout(finish, graceMs);
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      result.aborted = true;
      kill();
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      result.aborted = true;
      return finish();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', ...env } });
    } catch (e) {
      result.spawnError = e;
      return finish();
    }
    const take = (name) => (chunk) => {
      if (result[name].length < maxBuffer) result[name] += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', take('stdout'));
    child.stderr.setEncoding('utf8').on('data', take('stderr'));
    child.on('error', (e) => {
      result.spawnError = e;
      finish();
    });
    child.on('close', (code) => {
      result.code = code;
      finish();
    });
  });
}

// One-line reason for a failed run.
export function describeFailure(cmd, r) {
  if (r.spawnError) return `${cmd} could not be started: ${r.spawnError.message}`;
  if (r.timedOut) return `${cmd} did not finish in time`;
  if (r.aborted) return `${cmd} was aborted`;
  const err = r.stderr.trim().split('\n')[0];
  return `${cmd} failed (exit ${r.code})${err ? `: ${err}` : ''}`;
}

// ---------- generic value thresholds (sqlite-query, json-file) ----------
export const THRESHOLD_KEYS = ['warn_above', 'crit_above', 'warn_below', 'crit_below'];

// Error messages for the threshold parameters: numbers, warn on the milder side of crit.
export function validateThresholds(params) {
  const errors = [];
  for (const k of THRESHOLD_KEYS) {
    if (params[k] !== undefined && !isNumber(params[k])) errors.push(`${k} must be a number`);
  }
  if (isNumber(params.warn_above) && isNumber(params.crit_above) && params.warn_above > params.crit_above) {
    errors.push('warn_above must not exceed crit_above');
  }
  if (isNumber(params.warn_below) && isNumber(params.crit_below) && params.warn_below < params.crit_below) {
    errors.push('warn_below must not be lower than crit_below');
  }
  return errors;
}

// Worst of the "at or above" and "at or below" verdicts; ok if no threshold is configured.
export function evaluateThresholds(value, params) {
  const rank = { ok: 0, warn: 1, crit: 2 };
  const above = level(value, params.warn_above, params.crit_above);
  const below = level(-value, isNumber(params.warn_below) ? -params.warn_below : undefined, isNumber(params.crit_below) ? -params.crit_below : undefined);
  return rank[above] >= rank[below] ? above : below;
}
