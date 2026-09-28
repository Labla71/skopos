// Generic JSON file check: reads a local JSON file and rates one field and the age of the
// file. Both are configuration; nothing about the file lives in the code.
//   key `value`: the field (dotted path, e.g. "result.status" or "items.0.count"), against
//                `expected` (equality, deviation is `severity`, default crit) and/or the
//                numeric thresholds (warn_above, crit_above, warn_below, crit_below).
//   key `age`:   seconds since the file's mtime, against warn_age_seconds / crit_age_seconds.
// Without `field` only the age is measured. Missing file, no permission, unparsable (e.g.
// half-written) content, missing field or a value of the wrong type is `unknown` with a
// reason, never a zero.
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { evaluateThresholds, isNumber, level, round1, THRESHOLD_KEYS, validateThresholds } from './util.js';

const MAX_BYTES = 1024 * 1024;
const FUTURE_TOLERANCE_MS = 60 * 1000;
const unknown = (key, reason) => ({ key, status: 'unknown', reason });

function describeError(e) {
  if (e.code === 'ENOENT') return 'file not found';
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'no read permission';
  if (e.code === 'EISDIR') return 'path is a directory, not a file';
  return `cannot read file: ${e.code ?? e.message}`;
}

// Value of a dotted path; { missing: true } if any step is absent.
export function lookup(data, path) {
  let cur = data;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return { missing: true };
    cur = cur[part];
  }
  return { value: cur };
}

export function createJsonFileCheck({ now = () => Date.now() } = {}) {
  return {
    name: 'json-file',
    required: ['file'],
    optional: ['field', 'expected', 'severity', 'unit', 'warn_age_seconds', 'crit_age_seconds', ...THRESHOLD_KEYS],
    validate(params) {
      const errors = [];
      if (typeof params.file !== 'string' || !isAbsolute(params.file) || params.file.includes('\0')) errors.push('file must be an absolute path');
      if (params.field !== undefined && (typeof params.field !== 'string' || !params.field)) errors.push('field must be a non-empty string');
      const rated = params.expected !== undefined || THRESHOLD_KEYS.some((k) => params[k] !== undefined);
      if (params.field === undefined && (rated || params.severity !== undefined || params.unit !== undefined)) {
        errors.push('expected, severity, unit and the value thresholds need a field');
      }
      if (params.expected !== undefined && !['string', 'number', 'boolean'].includes(typeof params.expected)) errors.push('expected must be a string, number or boolean');
      if (params.expected !== undefined && THRESHOLD_KEYS.some((k) => params[k] !== undefined)) errors.push('expected and numeric thresholds cannot be combined');
      if (params.severity !== undefined && !['warn', 'crit'].includes(params.severity)) errors.push('severity must be "warn" or "crit"');
      if (params.unit !== undefined && typeof params.unit !== 'string') errors.push('unit must be a string');
      for (const k of ['warn_age_seconds', 'crit_age_seconds']) {
        if (params[k] !== undefined && !(isNumber(params[k]) && params[k] >= 0)) errors.push(`${k} must be a number ≥ 0`);
      }
      if (isNumber(params.warn_age_seconds) && isNumber(params.crit_age_seconds) && params.warn_age_seconds > params.crit_age_seconds) {
        errors.push('warn_age_seconds must not exceed crit_age_seconds');
      }
      return [...errors, ...validateThresholds(params)];
    },
    async measure(params) {
      const keys = params.field === undefined ? ['age'] : ['value', 'age'];
      let handle;
      let text;
      let mtimeMs;
      try {
        handle = await open(params.file, 'r');
        const st = await handle.stat();
        if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
        if (st.size > MAX_BYTES) return keys.map((k) => unknown(k, `file is larger than ${MAX_BYTES} bytes`));
        mtimeMs = st.mtimeMs;
        text = await handle.readFile('utf8');
      } catch (e) {
        return keys.map((k) => unknown(k, describeError(e)));
      } finally {
        await handle?.close();
      }
      const results = [];
      if (params.field !== undefined) results.push(measureField(text, params));
      results.push(measureAge(now() - mtimeMs, params));
      return results;
    },
  };
}

function measureField(text, params) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return unknown('value', 'file is not valid JSON (possibly half-written)');
  }
  const found = lookup(data, params.field);
  if (found.missing) return unknown('value', `field "${params.field}" is missing`);
  let v = found.value;
  if (typeof v === 'boolean') v = String(v);
  if (typeof v !== 'string' && !isNumber(v)) {
    return unknown('value', `field "${params.field}" has type ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}, expected string, number or boolean`);
  }
  const result = { key: 'value', value: v, status: 'ok' };
  if (params.unit !== undefined) result.unit = params.unit;
  if (params.expected !== undefined) {
    // Booleans are compared as text ("true"/"false"); everything else strictly, no coercion.
    const want = typeof params.expected === 'boolean' ? String(params.expected) : params.expected;
    if (v !== want) {
      result.status = params.severity ?? 'crit';
      result.reason = `field "${params.field}" is ${JSON.stringify(v)}, expected ${JSON.stringify(params.expected)}`;
    }
  } else if (THRESHOLD_KEYS.some((k) => params[k] !== undefined)) {
    if (typeof v !== 'number') return unknown('value', `field "${params.field}" is text, numeric thresholds need a number`);
    result.status = evaluateThresholds(v, params);
  }
  return result;
}

function measureAge(ageMs, params) {
  if (ageMs < -FUTURE_TOLERANCE_MS) return unknown('age', 'file modification time is in the future (clock skew?)');
  const seconds = round1(Math.max(0, ageMs) / 1000);
  return { key: 'age', value: seconds, unit: 's', status: level(seconds, params.warn_age_seconds, params.crit_age_seconds) };
}

export default createJsonFileCheck();
