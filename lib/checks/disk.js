// Usage per configured mount point in percent, from `df -P -k <path>`.
import { checkNumber, checkOrder, checkPaths, keyFrom, level, round1, run, describeFailure, unknown } from './util.js';

const DEFAULTS = { warn_percent: 85, crit_percent: 95 };

// Parses the POSIX df output for one path: { usedPercent } or an { error }.
export function parseDf(text) {
  const lines = String(text).split('\n').filter((l) => l.trim());
  if (lines.length !== 2) return { error: `unexpected df output (${lines.length} lines)` };
  const f = lines[1].trim().split(/\s+/);
  if (f.length < 6) return { error: 'unexpected df output (too few columns)' };
  const used = Number(f[2]);
  const avail = Number(f[3]);
  if (!/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3])) return { error: 'unexpected df output (non-numeric sizes)' };
  if (used + avail === 0) return { error: 'df reports a filesystem of size 0' };
  // Same definition as df's Use%: used / (used + available), not used / total.
  return { usedPercent: round1((used / (used + avail)) * 100) };
}

const defaultDf = (path, { signal, timeoutMs }) => run('df', ['-P', '-k', '--', path], { signal, timeoutMs });

export function createDiskCheck({ df = defaultDf } = {}) {
  return {
    name: 'disk',
    required: ['mounts'],
    optional: Object.keys(DEFAULTS),
    validate(params) {
      const errors = [
        ...Object.keys(DEFAULTS).flatMap((k) => checkNumber(params, k, { min: 0, max: 100 })),
        ...checkOrder({ ...DEFAULTS, ...params }, 'warn_percent', 'crit_percent'),
      ];
      return [...errors, ...checkPaths(params.mounts, 'mounts')];
    },
    async measure(params, ctx) {
      const t = { ...DEFAULTS, ...params };
      const out = [];
      for (const path of params.mounts) {
        const key = keyFrom(path);
        const r = await df(path, { signal: ctx?.signal, timeoutMs: 10000 });
        if (r.spawnError || r.timedOut || r.aborted || r.code !== 0) {
          out.push(unknown(key, `${path}: ${describeFailure('df', r)}`));
          continue;
        }
        const p = parseDf(r.stdout);
        if (p.error) {
          out.push(unknown(key, `${path}: ${p.error}`));
          continue;
        }
        const st = level(p.usedPercent, t.warn_percent, t.crit_percent);
        out.push({ key, value: p.usedPercent, unit: '%', status: st, reason: st === 'ok' ? undefined : `${path} ${p.usedPercent} % full` });
      }
      return out;
    },
  };
}

export default createDiskCheck();
