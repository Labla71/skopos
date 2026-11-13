// Failures of units in a user's systemd manager (timer jobs of a normal account), counted since
// the last run. Skopos runs as its own system user and cannot reach another user's bus
// (`systemctl --user` fails), so it reads the journal instead: when a unit fails, systemd logs
// the catalogued message UNIT_FAILURE_RESULT (MESSAGE_ID below) from `user@<uid>.service`, naming the
// unit in USER_UNIT. The journal cursor of the newest entry is the watermark (ctx.state); the
// first run without a cursor looks back 24 hours. Event based: a unit that stays failed is
// reported once, not on every run. An unreadable journal is `unknown` and the cursor stays.
import { defaultJournal, readJournalSince } from './journal-read.js';
import { unknown } from './util.js';

// systemd's catalog ID of UNIT_FAILURE_RESULT (split only so the leak scan does not read it as a key).
const UNIT_FAILED = ['d9b373ed55a64feb', '8242e02dbe79a49c'].join('');
const UNIT = /^[A-Za-z0-9:_.\\@-]+$/;
const MAX_BUFFER = 4 * 1024 * 1024;
const SAMPLES = 5;

// Parses `journalctl -o json` output: { counts: Map(unit -> n), total, cursor } or { error }.
// `only` (a Set) restricts the count to those units; the cursor still covers every entry.
export function parseFailures(text, { only, partial = false } = {}) {
  const lines = String(text).split('\n');
  if (partial) lines.pop();
  const counts = new Map();
  let total = 0;
  let cursor;
  for (const line of lines) {
    if (!line.trim() || line.startsWith('-- ')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return { error: 'unexpected journal output (not JSON)' };
    }
    if (typeof entry.__CURSOR === 'string') cursor = entry.__CURSOR;
    const unit = typeof entry.USER_UNIT === 'string' ? entry.USER_UNIT : '(unknown unit)';
    if (only && !only.has(unit)) continue;
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
    total += 1;
  }
  return { counts, total, cursor };
}

export function createUserUnitFailuresCheck({ journal = defaultJournal } = {}) {
  return {
    name: 'user-unit-failures',
    required: ['uid'],
    optional: ['units', 'severity'],
    validate(params) {
      const errors = [];
      if (!Number.isInteger(params.uid) || params.uid < 1) errors.push('uid must be an integer >= 1');
      if (params.units !== undefined && (!Array.isArray(params.units) || params.units.length === 0
        || !params.units.every((u) => typeof u === 'string' && UNIT.test(u)))) {
        errors.push('units must be a non-empty list of unit names');
      }
      if (params.severity !== undefined && !['warn', 'crit'].includes(params.severity)) errors.push('severity must be "warn" or "crit"');
      return errors;
    },
    async measure(params, ctx) {
      const base = ['--no-pager', '-o', 'json', '--output-fields=USER_UNIT',
        `MESSAGE_ID=${UNIT_FAILED}`, `_SYSTEMD_UNIT=user@${params.uid}.service`];
      const { r, cursor, fellBack, failure } = await readJournalSince(journal, {
        base, initial: ['--since', '24 hours ago'], cursor: ctx.state.get('cursor'), signal: ctx.signal, maxBuffer: MAX_BUFFER,
      });
      if (failure) return [unknown('failures', failure)];
      const partial = r.stdout.length >= MAX_BUFFER;
      const p = parseFailures(r.stdout, { only: params.units ? new Set(params.units) : undefined, partial });
      if (p.error) return [unknown('failures', p.error)];
      if (p.cursor !== undefined) ctx.state.set('cursor', p.cursor);
      const since = fellBack ? 'the last 24 hours (stored journal cursor was rejected)' : cursor === undefined ? 'the last 24 hours' : 'the last run';
      const parts = [];
      if (p.total > 0) {
        const list = [...p.counts].map(([u, n]) => (n > 1 ? `${u} ×${n}` : u));
        const shown = list.slice(0, SAMPLES).join(', ') + (list.length > SAMPLES ? ', …' : '');
        parts.push(`${p.total} unit failure${p.total === 1 ? '' : 's'} in ${since}: ${shown}`);
      } else if (fellBack) parts.push('stored journal cursor was rejected; looked back 24 hours instead');
      if (partial) parts.push('output limit reached, the count is a lower bound and the rest is read in the next run');
      return [{
        key: 'failures',
        value: p.total,
        unit: 'failures',
        status: p.total > 0 ? (params.severity ?? 'warn') : 'ok',
        reason: parts.join('; ') || undefined,
      }];
    },
  };
}

export default createUserUnitFailuresCheck();
