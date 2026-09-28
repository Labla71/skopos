// Error entries in the journal since the last run (semantics of the former log scan: priority
// err..emerg, optional unit filter, exclusion patterns). The journal cursor is the watermark
// (ctx.state); the first run without a cursor looks back 24 hours. Everything is counted; only
// a few samples are kept in the reason. The output of one run is bounded (MAX_BUFFER): if it is
// hit, the count is a lower bound and the cursor stops at the last complete entry, so the rest
// is read in the next run. An unreadable journal is `unknown` and the cursor stays.
import { defaultJournal, entryMessage, readJournalSince } from './journal-read.js';
import { unknown } from './util.js';

const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning'];
const UNIT = /^[A-Za-z0-9:_.\\@-]+$/;
const SAMPLES = 3;
const SAMPLE_CHARS = 160;
const MAX_BUFFER = 8 * 1024 * 1024;

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const clip = (text) => (text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS - 1)}…` : text);

// Parses `journalctl -o json` output: { count, excluded, samples, cursor } or { error }.
// `partial` marks output cut at the buffer limit: its last line may be incomplete and is dropped.
export function parseEntries(text, { exclude = [], partial = false } = {}) {
  const lines = String(text).split('\n');
  if (partial) lines.pop();
  let count = 0;
  let excluded = 0;
  let cursor;
  const samples = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('-- ')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return { error: 'unexpected journal output (not JSON)' };
    }
    if (typeof entry.__CURSOR === 'string') cursor = entry.__CURSOR;
    const msg = entryMessage(entry);
    const message = typeof msg === 'string' ? oneLine(msg) : '(binary message)';
    if (exclude.some((re) => re.test(message))) {
      excluded += 1;
      continue;
    }
    count += 1;
    if (samples.length < SAMPLES) {
      const unit = typeof entry._SYSTEMD_UNIT === 'string' ? `${entry._SYSTEMD_UNIT}: ` : '';
      samples.push(clip(unit + message));
    }
  }
  return { count, excluded, samples, cursor };
}

function regexErrors(list) {
  if (!Array.isArray(list) || !list.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 200)) {
    return ['exclude must be a list of non-empty patterns (at most 200 characters)'];
  }
  const errors = [];
  for (const p of list) {
    try {
      new RegExp(p, 'i');
    } catch {
      errors.push(`exclude: "${p}" is not a valid regular expression`);
    }
  }
  return errors;
}

export function createJournalCheck({ journal = defaultJournal } = {}) {
  return {
    name: 'journal',
    required: [],
    optional: ['units', 'priority', 'exclude', 'severity'],
    validate(params) {
      const errors = [];
      if (params.units !== undefined && (!Array.isArray(params.units) || params.units.length === 0
        || !params.units.every((u) => typeof u === 'string' && UNIT.test(u)))) {
        errors.push('units must be a non-empty list of unit names');
      }
      if (params.priority !== undefined && !PRIORITIES.includes(params.priority)) {
        errors.push(`priority must be one of ${PRIORITIES.join(', ')}`);
      }
      if (params.exclude !== undefined) errors.push(...regexErrors(params.exclude));
      if (params.severity !== undefined && !['warn', 'crit'].includes(params.severity)) errors.push('severity must be "warn" or "crit"');
      return errors;
    },
    async measure(params, ctx) {
      const base = ['--no-pager', '-o', 'json', '--output-fields=MESSAGE,_SYSTEMD_UNIT', '-p', params.priority ?? 'err',
        ...(params.units ?? []).flatMap((u) => ['-u', u])];
      const { r, cursor, fellBack, failure } = await readJournalSince(journal, {
        base, initial: ['--since', '24 hours ago'], cursor: ctx.state.get('cursor'), signal: ctx.signal, maxBuffer: MAX_BUFFER,
      });
      if (failure) return [unknown('errors', failure)];
      const partial = r.stdout.length >= MAX_BUFFER;
      const exclude = (params.exclude ?? []).map((p) => new RegExp(p, 'i'));
      const p = parseEntries(r.stdout, { exclude, partial });
      if (p.error) return [unknown('errors', p.error)];
      if (p.cursor !== undefined) ctx.state.set('cursor', p.cursor);
      const since = fellBack ? 'the last 24 hours (stored journal cursor was rejected)' : cursor === undefined ? 'the last 24 hours' : 'the last run';
      const parts = [];
      if (p.count > 0) parts.push(`${p.count} journal entr${p.count === 1 ? 'y' : 'ies'} in ${since}: ${p.samples.join(' | ')}${p.count > p.samples.length ? ' | …' : ''}`);
      else if (fellBack) parts.push('stored journal cursor was rejected; looked back 24 hours instead');
      if (partial) parts.push('output limit reached, the count is a lower bound and the rest is read in the next run');
      return [{
        key: 'errors',
        value: p.count,
        unit: 'entries',
        status: p.count > 0 ? (params.severity ?? 'warn') : 'ok',
        reason: parts.join('; ') || undefined,
      }];
    },
  };
}

export default createJournalCheck();
