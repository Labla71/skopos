// Shared journal access of the checks that count entries since the last run (oom, journal).
// The journal cursor of the newest entry is the watermark (ctx.state). If journalctl rejects
// the stored cursor, the read falls back to the `initial` arguments once and reports it.
import { describeFailure, run } from './util.js';

export const defaultJournal = (args, { signal, maxBuffer } = {}) => run('journalctl', args, { signal, maxBuffer, timeoutMs: 20000 });

// Reads with `journal(args, { signal, maxBuffer })`. Returns { r, cursor, fellBack, failure }:
// `failure` is a one-line reason if the journal could not be read (then the caller reports
// `unknown` and leaves the stored cursor alone), otherwise `r` is the finished run.
// `cursor` is the stored cursor that was actually used (undefined after a fallback).
export async function readJournalSince(journal, { base, initial, cursor, signal, maxBuffer, what = 'journal' }) {
  let used = typeof cursor === 'string' ? cursor : undefined;
  let fellBack = false;
  const read = () => journal([...base, ...(used ? ['--after-cursor', used] : initial)], { signal, maxBuffer });
  let r = await read();
  if (used && r.code !== 0 && /failed to seek to cursor/i.test(r.stderr)) {
    used = undefined;
    fellBack = true;
    r = await read();
  }
  let failure;
  if (r.spawnError || r.timedOut || r.aborted || r.code !== 0) failure = describeFailure('journalctl', r);
  // journalctl exits 0 without permission and only hints on stderr.
  else if (/insufficient permissions|not seeing messages/i.test(r.stderr)) failure = `${what} not readable (user needs the systemd-journal group)`;
  return { r, cursor: used, fellBack, failure };
}

// The message of a JSON journal entry as text (binary messages arrive as byte arrays).
export const entryMessage = (entry) => (Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString('utf8') : entry.MESSAGE);
