// Collector configuration: one JSON file on the collecting host, validated as strictly as the
// measuring configuration (unknown keys abort, all errors are reported together).
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ConfigError } from '../config.js';

export const COLLECT_DEFAULTS = Object.freeze({
  confirm_runs: 2,              // N Skopos runs not ok -> problem confirmed (hard state)
  recover_runs: 2,              // N runs ok again -> recovery confirmed
  unknown_confirm_runs: 3,      // N runs unknown -> "does not measure"
  host_confirm_polls: 2,        // polls before "unreachable" and report errors are confirmed
  flap_changes: 4,              // K confirmed changes ...
  flap_window_minutes: 60,      // ... within this window -> "unstable"
  max_notifications_per_hour: 5,
  initial_lookback_minutes: 30, // first poll of a host: look back this far only
  fetch_timeout_seconds: 60,
});
const DEFAULT_COMMAND = '/opt/skopos/bin/skopos.js';
// The state machine remembers the last 10 observations per entity (machine.js, MAX_RECENT);
// a run count above that could never be reached.
export const MAX_RUNS = 10;
const RUN_KEYS = ['confirm_runs', 'recover_runs', 'unknown_confirm_runs', 'host_confirm_polls', 'crit_confirm_runs'];
const TOP_LEVEL = ['_comment', 'hosts', 'state_file', 'notifier', 'overrides', ...Object.keys(COLLECT_DEFAULTS)];
const HOST_KEYS = ['_comment', 'name', 'ssh', 'local', 'command'];
const OVERRIDE_KEYS = ['_comment', 'confirm_runs', 'recover_runs', 'crit_confirm_runs'];
const NOTIFIER_KEYS = ['_comment', 'type', 'command', 'timeout_seconds'];
const NAME = /^[A-Za-z0-9._-]+$/;
// Override key: a check module ("oom"), or module/key ("sqlite-query/rpc_denied_new").
const OVERRIDE_KEY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;
// The ssh target ends up in an argument vector, never in a shell; still no option-like values.
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isPositiveInteger = (x) => Number.isInteger(x) && x >= 1;
const isAbsPath = (x) => typeof x === 'string' && isAbsolute(x) && !x.includes('\0');

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}unknown key "${k}"`);
}

export function validateCollectConfig(raw) {
  const errors = [];
  if (!isObject(raw)) throw new ConfigError(['root must be a JSON object']);
  unknownKeys(raw, TOP_LEVEL, '', errors);
  const cfg = { ...COLLECT_DEFAULTS, hosts: [], overrides: {} };

  for (const k of Object.keys(COLLECT_DEFAULTS)) {
    if (raw[k] === undefined) continue;
    if (!isPositiveInteger(raw[k])) errors.push(`${k} must be an integer ≥ 1`);
    else if (RUN_KEYS.includes(k) && raw[k] > MAX_RUNS) errors.push(`${k} must not exceed ${MAX_RUNS}`);
    else cfg[k] = raw[k];
  }

  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) {
    errors.push('hosts is missing or empty (at least one host required)');
  } else {
    const seen = new Set();
    raw.hosts.forEach((h, i) => {
      const where = `hosts[${i}]: `;
      if (!isObject(h)) return errors.push(`${where}must be an object`);
      unknownKeys(h, HOST_KEYS, where, errors);
      if (typeof h.name !== 'string' || !NAME.test(h.name)) return errors.push(`${where}name is missing or contains characters other than A-Z a-z 0-9 . _ -`);
      if (seen.has(h.name)) errors.push(`${where}host "${h.name}" appears twice`);
      seen.add(h.name);
      if (h.local !== undefined && typeof h.local !== 'boolean') errors.push(`${where}local must be true or false`);
      if (h.local === true && h.ssh !== undefined) errors.push(`${where}local and ssh cannot be combined`);
      if (h.ssh !== undefined && (typeof h.ssh !== 'string' || !SSH_TARGET.test(h.ssh))) errors.push(`${where}ssh must be a host alias such as "example-host" or "user@example-host"`);
      if (h.command !== undefined && !isAbsPath(h.command)) errors.push(`${where}command must be an absolute path`);
      cfg.hosts.push({ name: h.name, local: h.local === true, ssh: h.local === true ? undefined : h.ssh ?? h.name, command: h.command ?? DEFAULT_COMMAND });
    });
  }

  if (!isAbsPath(raw.state_file)) errors.push('state_file is missing or not an absolute path');
  else cfg.state_file = raw.state_file;

  const n = raw.notifier;
  if (!isObject(n)) {
    errors.push('notifier is missing (an object with "type")');
  } else {
    unknownKeys(n, NOTIFIER_KEYS, 'notifier: ', errors);
    if (n.type !== 'command') errors.push(`notifier: unknown type ${JSON.stringify(n.type)} (available: "command")`);
    else if (!Array.isArray(n.command) || n.command.length === 0 || !isAbsPath(n.command[0]) || !n.command.every((a) => typeof a === 'string')) {
      errors.push('notifier: command must be a list of strings starting with an absolute path');
    }
    if (n.timeout_seconds !== undefined && !isPositiveInteger(n.timeout_seconds)) errors.push('notifier: timeout_seconds must be an integer ≥ 1');
    cfg.notifier = { type: n.type, command: n.command, timeout_seconds: n.timeout_seconds ?? 30 };
  }

  if (raw.overrides !== undefined) {
    if (!isObject(raw.overrides)) errors.push('overrides must be an object keyed by check name or check/key');
    else {
      for (const [check, o] of Object.entries(raw.overrides)) {
        const where = `overrides.${check}: `;
        if (!OVERRIDE_KEY.test(check)) { errors.push(`${where}key must be a check name or check/key`); continue; }
        if (!isObject(o)) { errors.push(`${where}must be an object`); continue; }
        unknownKeys(o, OVERRIDE_KEYS, where, errors);
        for (const k of OVERRIDE_KEYS.slice(1)) {
          if (o[k] !== undefined && !(isPositiveInteger(o[k]) && o[k] <= MAX_RUNS)) errors.push(`${where}${k} must be an integer from 1 to ${MAX_RUNS}`);
        }
        cfg.overrides[check] = o;
      }
    }
  }

  if (errors.length) throw new ConfigError(errors);
  return cfg;
}

export function loadCollectConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError([`configuration file ${path} is not readable: ${e.message}`]);
  }
  try {
    return validateCollectConfig(JSON.parse(text));
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError([`${path} is not valid JSON: ${e.message}`]);
  }
}
