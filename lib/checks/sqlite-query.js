// Generic read-only SQL check: runs one configured SELECT against a foreign SQLite database
// and rates the single number it returns against thresholds. What is measured is pure
// configuration; the query never lives in the code. The database is opened read-only through
// lib/sqlite-read.js (decision 5). Whatever cannot be measured is `unknown` with a reason:
// missing file or permission, unusable query, no row / several rows / several columns, NULL
// (unless `null_as` says so explicitly), text instead of a number.
//
// `delta: true` rates the increase of a counter since the last run instead of the value. The
// previous value is the watermark (ctx.state). What a falling value means depends on the
// counter, so `on_decrease` must say it explicitly:
//   "restart" — the counter really starts again (e.g. a per-day count): everything counted
//               since the restart is the delta, never a negative number;
//   "rebase"  — the value should never fall (e.g. a sum over all rows); a fall means rows
//               were deleted or restored, so the new value becomes the baseline and the run is
//               `unknown` with a reason, instead of reporting the whole remaining sum as new.
import { isAbsolute } from 'node:path';
import { checkQuery, ReadError, withReadOnly } from '../sqlite-read.js';
import { evaluateThresholds, isNumber, THRESHOLD_KEYS, validateThresholds } from './util.js';

const unknown = (reason) => ({ status: 'unknown', reason });

// Exactly one row; at most two are fetched so that a huge result set costs no memory.
function fetchRow(db, sql) {
  const rows = [];
  for (const row of db.prepare(sql).iterate()) {
    rows.push(row);
    if (rows.length > 1) break;
  }
  return rows;
}

// The one number of the result, or { reason } why there is none.
function pickValue(rows, params) {
  if (rows.length === 0) return { reason: 'query returned no row' };
  if (rows.length > 1) return { reason: 'query returned more than one row' };
  const row = rows[0];
  const columns = Object.keys(row);
  let name = params.column;
  if (name === undefined) {
    if (columns.length !== 1) return { reason: `query returned ${columns.length} columns; set "column" to pick one` };
    name = columns[0];
  } else if (!columns.includes(name)) {
    return { reason: `column "${name}" is not in the query result` };
  }
  const v = row[name];
  if (v === null) {
    if (params.null_as === undefined) return { reason: `value of "${name}" is NULL (set null_as to count it as a number)` };
    return { value: params.null_as, note: `NULL counted as ${params.null_as}` };
  }
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? { value: n } : { reason: `value of "${name}" is too large to be exact` };
  }
  if (typeof v !== 'number') return { reason: `value of "${name}" is ${typeof v === 'string' ? 'text' : 'not a number'}, expected a number` };
  if (!Number.isFinite(v)) return { reason: `value of "${name}" is not finite` };
  return { value: v };
}

export function createSqliteQueryCheck({ read = withReadOnly } = {}) {
  return {
    name: 'sqlite-query',
    required: ['database', 'query'],
    optional: ['column', 'null_as', 'unit', 'delta', 'on_decrease', ...THRESHOLD_KEYS],
    validate(params) {
      const errors = [];
      if (typeof params.database !== 'string' || !isAbsolute(params.database) || params.database.includes('\0')) {
        errors.push('database must be an absolute path');
      }
      const q = checkQuery(params.query);
      if (q) errors.push(q);
      if (params.column !== undefined && (typeof params.column !== 'string' || !params.column)) errors.push('column must be a non-empty string');
      if (params.null_as !== undefined && !isNumber(params.null_as)) errors.push('null_as must be a number');
      if (params.unit !== undefined && typeof params.unit !== 'string') errors.push('unit must be a string');
      if (params.delta !== undefined && typeof params.delta !== 'boolean') errors.push('delta must be true or false');
      if (params.delta === true && !['restart', 'rebase'].includes(params.on_decrease)) {
        errors.push('delta needs on_decrease: "restart" (the counter really starts again) or "rebase" (a fall means deleted or restored rows)');
      }
      if (params.delta !== true && params.on_decrease !== undefined) errors.push('on_decrease only applies with delta: true');
      return [...errors, ...validateThresholds(params)];
    },
    async measure(params, ctx) {
      // Second look at the query: measure() may be called without validate().
      const bad = checkQuery(params.query);
      if (bad) return [unknown(bad)];
      let picked;
      try {
        picked = read(params.database, (db) => pickValue(fetchRow(db, params.query), params)).result;
      } catch (e) {
        return [unknown(e instanceof ReadError ? e.message : `query failed: ${e.message}`)];
      }
      if (picked.reason) return [unknown(picked.reason)];

      let { value } = picked;
      const notes = picked.note ? [picked.note] : [];
      if (params.delta) {
        const previous = ctx.state.get('last');
        ctx.state.set('last', value);
        if (!isNumber(previous)) return [unknown('no baseline yet (first run); baseline stored')];
        if (value >= previous) {
          value -= previous;
        } else if (params.on_decrease === 'rebase') {
          return [unknown(`value decreased (was ${previous}, now ${value}), rows deleted or restored?; new baseline stored`)];
        } else {
          notes.push(`counter reset (was ${previous}, now ${value}); counted since the reset`);
        }
      }
      const result = { value, status: evaluateThresholds(value, params) };
      if (params.unit !== undefined) result.unit = params.unit;
      if (notes.length) result.reason = notes.join('; ');
      return [result];
    },
  };
}

export default createSqliteQueryCheck();
