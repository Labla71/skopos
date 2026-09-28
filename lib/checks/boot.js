// A reboot of the machine, reported exactly once. The boot ID (changes only at a boot) is the
// watermark (ctx.state). The first run without a stored ID only remembers it (baseline). When
// the ID has changed, the journal of the previous boot tells how it ended: `clean` (orderly
// shutdown found), `unclean` (journal readable, no shutdown found: crash, power loss, reset)
// or `unknown` (journal of the previous boot not persistent or not readable). The reboot is
// reported in every case; a doubtful end is never called clean.
//
// A clean reboot that was announced in advance (`skopos expect-reboot`, e.g. before a planned
// apt-driven kernel update) is not worth a `warn`: the marker file it leaves behind is read here
// and, if it is fresh enough, downgrades the result to `ok`. An `unclean` end always stays at
// its severity regardless of the marker — a crash is never "expected". The marker is a one-shot:
// consumed (deleted) on the very reboot it applies to, or earlier if it goes stale, so a marker
// left over from an aborted maintenance run can never attach itself to a later, unrelated reboot.
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { uptime as osUptime } from 'node:os';
import { defaultJournal, entryMessage } from './journal-read.js';
import { describeFailure, isNumber, unknown } from './util.js';

const KEY = 'reboots';
const TAIL_ENTRIES = 300;
// Messages of systemd (PID 1) that only appear during an orderly shutdown.
const SHUTDOWN = /^(?:Shutting down\.|Reached target (?:reboot|poweroff|halt|kexec)\.target\b)/;

const defaultReadBootId = async () => readFile('/proc/sys/kernel/random/boot_id', 'utf8');

// Same data directory on every host (see bin/install.sh) — no per-host configuration needed for
// the default marker to work.
export const DEFAULT_MARKER_PATH = '/var/lib/skopos/expected-reboot.json';
export const DEFAULT_MAX_AGE_MINUTES = 30;

// { createdAt, reason? } | { invalid: true } | null (no marker file).
async function defaultReadMarker(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? null : { invalid: true };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { invalid: true };
  }
  const createdAt = Date.parse(data?.created_at);
  if (!Number.isFinite(createdAt)) return { invalid: true };
  const reason = typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : undefined;
  return { createdAt, reason };
}

async function defaultRemoveMarker(path) {
  try {
    await rm(path, { force: true });
  } catch {
    // Best-effort: a marker that cannot be removed is at worst read again next run, where the
    // age check catches it once it goes stale.
  }
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

// Parses `journalctl -o json` output of the tail of the previous boot:
// { clean, lastAt, entries } or { error }.
export function parseTail(text) {
  let entries = 0;
  let clean = false;
  let lastAt;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return { error: 'unexpected journal output (not JSON)' };
    }
    entries += 1;
    const us = Number(e.__REALTIME_TIMESTAMP);
    if (Number.isFinite(us)) lastAt = Math.floor(us / 1000);
    const msg = entryMessage(e);
    if (e.SYSLOG_IDENTIFIER === 'systemd' && typeof msg === 'string' && SHUTDOWN.test(msg)) clean = true;
  }
  return { clean, lastAt, entries };
}

// How the previous boot ended: { end: 'clean' | 'unclean' | 'unknown', lastAt?, why? }.
async function previousEnd(journal, oldId, signal) {
  const id = oldId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(id)) return { end: 'unknown', why: 'stored boot ID is not valid' };
  const args = ['--no-pager', '-o', 'json', '--output-fields=MESSAGE,SYSLOG_IDENTIFIER', '-n', String(TAIL_ENTRIES), `_BOOT_ID=${id}`];
  let r;
  try {
    r = await journal(args, { signal });
  } catch (e) {
    return { end: 'unknown', why: `journalctl could not be run: ${e.message}` };
  }
  if (r.spawnError || r.timedOut || r.aborted || r.code !== 0) return { end: 'unknown', why: describeFailure('journalctl', r) };
  if (/insufficient permissions|not seeing messages/i.test(r.stderr)) return { end: 'unknown', why: 'journal not readable (user needs the systemd-journal group)' };
  const p = parseTail(r.stdout);
  if (p.error) return { end: 'unknown', why: p.error };
  if (p.entries === 0) return { end: 'unknown', why: 'journal of the previous boot not found (not persistent?)' };
  return { end: p.clean ? 'clean' : 'unclean', lastAt: p.lastAt };
}

export function createBootCheck({
  readBootId = defaultReadBootId, journal = defaultJournal, now = Date.now, uptime = osUptime,
  readMarker = defaultReadMarker, removeMarker = defaultRemoveMarker,
} = {}) {
  return {
    name: 'boot',
    required: [],
    optional: ['severity', 'unclean_severity', 'expected_marker', 'expected_max_age_minutes'],
    validate(params) {
      const errors = ['severity', 'unclean_severity'].filter((k) => params[k] !== undefined && !['warn', 'crit'].includes(params[k])).map((k) => `${k} must be "warn" or "crit"`);
      if (params.expected_marker !== undefined && (typeof params.expected_marker !== 'string' || !isAbsolute(params.expected_marker))) {
        errors.push('expected_marker must be an absolute path');
      }
      if (params.expected_max_age_minutes !== undefined && !(isNumber(params.expected_max_age_minutes) && params.expected_max_age_minutes > 0)) {
        errors.push('expected_max_age_minutes must be a number > 0');
      }
      return errors;
    },
    async measure(params, ctx) {
      let id;
      try {
        id = String(await readBootId()).trim();
      } catch (e) {
        return [unknown(KEY, `boot ID not readable: ${e.message}`)];
      }
      if (!id) return [unknown(KEY, 'boot ID is empty')];
      const old = ctx.state.get('boot_id');
      ctx.state.set('boot_id', id);

      const markerPath = params.expected_marker ?? DEFAULT_MARKER_PATH;
      const maxAgeMs = (params.expected_max_age_minutes ?? DEFAULT_MAX_AGE_MINUTES) * 60000;
      let marker = await readMarker(markerPath);
      // A marker that outlived its window belongs to a reboot that, for whatever reason, never
      // happened (or happened long ago) — never let it attach to a later, unrelated one.
      if (marker && !marker.invalid && now() - marker.createdAt > maxAgeMs) {
        await removeMarker(markerPath);
        marker = null;
      }

      if (typeof old !== 'string' || !old) return [{ key: KEY, value: 0, unit: 'reboots', status: 'ok', reason: 'baseline (first run, boot ID stored)' }];
      if (old === id) return [{ key: KEY, value: 0, unit: 'reboots', status: 'ok' }];

      const e = await previousEnd(journal, old, ctx.signal);
      const bootedAt = iso(now() - Math.floor(uptime()) * 1000);
      let detail;
      if (e.end === 'clean') detail = `previous boot ended clean (last entry ${iso(e.lastAt)})`;
      else if (e.end === 'unclean') detail = `previous boot ended unclean, no orderly shutdown found (last entry ${iso(e.lastAt)})`;
      else detail = `previous boot end unknown: ${e.why}`;
      let status = e.end === 'unclean' ? (params.unclean_severity ?? 'crit') : (params.severity ?? 'warn');

      if (e.end !== 'unclean' && marker && !marker.invalid) {
        status = 'ok';
        detail += marker.reason ? `; expected reboot (${marker.reason})` : '; expected reboot';
      }
      // One-shot regardless of outcome: this transition is decided, the marker cannot apply again.
      if (marker) await removeMarker(markerPath);

      return [{ key: KEY, value: 1, unit: 'reboots', status, reason: `reboot, booted at ${bootedAt}; ${detail}` }];
    },
  };
}

export default createBootCheck();
