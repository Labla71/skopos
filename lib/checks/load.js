// Load average 1/5/15 minutes relative to the number of cores, from /proc/loadavg.
// The thresholds apply to load5 and load15; load1 is recorded for the history only, because a
// one-minute peak on a small machine is normal.
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { checkNumber, checkOrder, isNumber, level, unknown } from './util.js';

const DEFAULTS = { warn_ratio: 1.5, crit_ratio: 3 };
const round2 = (x) => Math.round(x * 100) / 100;

export function parseLoadavg(text) {
  const m = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s/.exec(`${text}`);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function createLoadCheck({ readLoadavg = () => readFile('/proc/loadavg', 'utf8'), cores = () => availableParallelism() } = {}) {
  return {
    name: 'load',
    required: [],
    optional: Object.keys(DEFAULTS),
    validate(params) {
      return [
        ...Object.keys(DEFAULTS).flatMap((k) => checkNumber(params, k, { min: 0 })),
        ...checkOrder({ ...DEFAULTS, ...params }, 'warn_ratio', 'crit_ratio'),
      ];
    },
    async measure(params) {
      const t = { ...DEFAULTS, ...params };
      const keys = ['load1', 'load5', 'load15'];
      let text;
      try {
        text = await readLoadavg();
      } catch (e) {
        return keys.map((k) => unknown(k, `/proc/loadavg not readable: ${e.message}`));
      }
      const values = parseLoadavg(text);
      if (!values) return keys.map((k) => unknown(k, 'unexpected /proc/loadavg format'));
      const n = cores();
      if (!(isNumber(n) && n >= 1)) return keys.map((k) => unknown(k, 'number of cores not determinable'));
      return keys.map((key, i) => {
        const ratio = round2(values[i] / n);
        const st = key === 'load1' ? 'ok' : level(ratio, t.warn_ratio, t.crit_ratio);
        return { key, value: ratio, unit: 'per_core', status: st,
          reason: st === 'ok' ? undefined : `${key} ${values[i]} on ${n} cores (${ratio} per core)` };
      });
    },
  };
}

export default createLoadCheck();
