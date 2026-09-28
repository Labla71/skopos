// OOM kills since the last run, from the kernel journal. The journal cursor is the watermark
// (ctx.state); the first run without a cursor counts since the current boot. If the journal
// cannot be read the result is `unknown` and the cursor stays where it was. If journalctl
// rejects the stored cursor, the check falls back to counting since boot once and says so,
// instead of staying `unknown` until someone resets the state by hand.
import { defaultJournal, entryMessage, readJournalSince } from './journal-read.js';
import { unknown } from './util.js';

// One line per killed process, both for global and cgroup OOM kills.
const KILL = /(?:out of memory|oom-kill).*killed process \d+|^Killed process \d+.*\(.*\)/i;

// Parses `journalctl -o json` output: { count, cursor } (cursor of the newest entry).
export function parseJournal(text) {
  let count = 0;
  let cursor;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return { error: 'unexpected journal output (not JSON)' };
    }
    if (typeof entry.__CURSOR === 'string') cursor = entry.__CURSOR;
    const msg = entryMessage(entry);
    if (typeof msg === 'string' && KILL.test(msg)) count += 1;
  }
  return { count, cursor };
}

export function createOomCheck({ journal = defaultJournal } = {}) {
  return {
    name: 'oom',
    required: [],
    optional: ['severity'],
    validate(params) {
      return params.severity === undefined || ['warn', 'crit'].includes(params.severity) ? [] : ['severity must be "warn" or "crit"'];
    },
    async measure(params, ctx) {
      const base = ['-k', '--no-pager', '-o', 'json', '--output-fields=MESSAGE'];
      const { r, cursor, fellBack, failure } = await readJournalSince(journal, {
        base, initial: ['-b'], cursor: ctx.state.get('cursor'), signal: ctx.signal, what: 'kernel journal',
      });
      if (failure) return [unknown('kills', failure)];
      const note = fellBack ? 'stored journal cursor was rejected; counted since boot instead' : undefined;
      const p = parseJournal(r.stdout);
      if (p.error) return [unknown('kills', p.error)];
      if (cursor === undefined && p.cursor === undefined) {
        return [unknown('kills', `no kernel messages found since boot (journal empty or not readable)${note ? `; ${note}` : ''}`)];
      }
      if (p.cursor !== undefined) ctx.state.set('cursor', p.cursor);
      const st = p.count > 0 ? (params.severity ?? 'crit') : 'ok';
      const counted = p.count > 0 ? `${p.count} OOM kill(s) since ${note ? 'boot' : 'the last run'}` : undefined;
      const reason = [counted, note].filter(Boolean).join('; ') || undefined;
      return [{ key: 'kills', value: p.count, unit: 'kills', status: st, reason }];
    },
  };
}

export default createOomCheck();
