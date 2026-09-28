// Configuration: one JSON file, validated strictly. Unknown keys or checks and missing
// required values abort loudly (no silent default). Comments only in the `_comment` field.
import { readFileSync } from 'node:fs';
import { CHECKS } from './checks/index.js';

export const DEFAULT_CONFIG_PATH = '/etc/skopos/config.json';
export const DEFAULTS = { interval_minutes: 5, retention_days: 30, timeout_seconds: 30 };

const TOP_LEVEL = ['_comment', 'interval_minutes', 'retention_days', 'timeout_seconds', 'checks'];
const ENTRY_COMMON = ['_comment', 'check', 'key', 'timeout_seconds'];
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ConfigError extends Error {
  constructor(messages) {
    super(`Invalid configuration:\n- ${messages.join('\n- ')}`);
    this.name = 'ConfigError';
    this.messages = messages;
  }
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isPositiveInteger = (x) => Number.isInteger(x) && x >= 1;
const isPositiveNumber = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

export function validateConfig(raw, checks = CHECKS) {
  const errors = [];
  if (!isObject(raw)) throw new ConfigError(['root must be a JSON object']);

  for (const k of Object.keys(raw)) {
    if (!TOP_LEVEL.includes(k)) errors.push(`unknown key "${k}"`);
  }
  const config = { ...DEFAULTS, checks: [] };
  if (raw.interval_minutes !== undefined) {
    if (isPositiveInteger(raw.interval_minutes)) config.interval_minutes = raw.interval_minutes;
    else errors.push('interval_minutes must be an integer ≥ 1');
  }
  if (raw.retention_days !== undefined) {
    if (isPositiveInteger(raw.retention_days)) config.retention_days = raw.retention_days;
    else errors.push('retention_days must be an integer ≥ 1');
  }
  if (raw.timeout_seconds !== undefined) {
    if (isPositiveNumber(raw.timeout_seconds)) config.timeout_seconds = raw.timeout_seconds;
    else errors.push('timeout_seconds must be a number > 0');
  }

  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    errors.push('checks is missing or empty (at least one check required)');
  } else {
    const seen = new Set();
    raw.checks.forEach((e, i) => {
      const where = `checks[${i}]`;
      if (!isObject(e)) return errors.push(`${where} must be an object`);
      // Object.hasOwn: names such as "toString" or "__proto__" are not checks.
      const module = typeof e.check === 'string' && Object.hasOwn(checks, e.check) ? checks[e.check] : undefined;
      if (!module) return errors.push(`${where}: unknown check "${e.check}"`);
      if (typeof e.key !== 'string' || !KEY_PATTERN.test(e.key)) {
        return errors.push(`${where} (${e.check}): key is missing or contains characters other than A-Z a-z 0-9 _ -`);
      }
      const id = `${e.check}/${e.key}`;
      if (seen.has(id)) errors.push(`${where}: ${id} appears twice`);
      seen.add(id);

      const allowed = [...ENTRY_COMMON, ...module.required, ...module.optional];
      for (const k of Object.keys(e)) {
        if (!allowed.includes(k)) errors.push(`${where} (${id}): unknown key "${k}"`);
      }
      for (const k of module.required) {
        if (e[k] === undefined) errors.push(`${where} (${id}): required value "${k}" is missing`);
      }
      if (e.timeout_seconds !== undefined && !isPositiveNumber(e.timeout_seconds)) {
        errors.push(`${where} (${id}): timeout_seconds must be a number > 0`);
      }
      const params = Object.fromEntries(Object.entries(e).filter(([k]) => !ENTRY_COMMON.includes(k)));
      for (const m of module.validate?.(params) ?? []) errors.push(`${where} (${id}): ${m}`);
      config.checks.push({ check: e.check, key: e.key, timeout_seconds: e.timeout_seconds, params });
    });
  }

  if (errors.length) throw new ConfigError(errors);
  return config;
}

export function loadConfig(path = DEFAULT_CONFIG_PATH, checks = CHECKS) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError([`configuration file ${path} is not readable: ${e.message}`]);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`${path} is not valid JSON: ${e.message}`]);
  }
  return validateConfig(raw, checks);
}
