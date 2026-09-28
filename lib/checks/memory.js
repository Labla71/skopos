// RAM and swap usage in percent, from /proc/meminfo.
import { readFile } from 'node:fs/promises';
import { checkNumber, checkOrder, isNumber, level, round1, unknown } from './util.js';

const DEFAULTS = { ram_warn_percent: 90, ram_crit_percent: 95, swap_warn_percent: 50, swap_crit_percent: 80 };

// Parses "Name:   123 kB" lines into { Name: bytes }.
export function parseMeminfo(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([A-Za-z_()0-9]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * (line.trimEnd().endsWith('kB') ? 1024 : 1);
  }
  return out;
}

export function evaluate(text, params) {
  const t = { ...DEFAULTS, ...params };
  const info = parseMeminfo(text);
  const results = [];

  const total = info.MemTotal;
  const avail = info.MemAvailable;
  if (!(total > 0) || !isNumber(avail) || avail > total) {
    results.push(unknown('ram', 'MemTotal/MemAvailable missing or invalid in /proc/meminfo'));
  } else {
    const pct = round1(((total - avail) / total) * 100);
    results.push({ key: 'ram', value: pct, unit: '%', status: level(pct, t.ram_warn_percent, t.ram_crit_percent),
      reason: level(pct, t.ram_warn_percent, t.ram_crit_percent) === 'ok' ? undefined : `RAM ${pct} % in use` });
  }

  const swapTotal = info.SwapTotal;
  const swapFree = info.SwapFree;
  if (!isNumber(swapTotal) || !isNumber(swapFree) || swapFree > swapTotal) {
    results.push(unknown('swap', 'SwapTotal/SwapFree missing or invalid in /proc/meminfo'));
  } else if (swapTotal === 0) {
    results.push({ key: 'swap', value: 0, unit: '%', status: 'ok', reason: 'no swap configured' });
  } else {
    const pct = round1(((swapTotal - swapFree) / swapTotal) * 100);
    const st = level(pct, t.swap_warn_percent, t.swap_crit_percent);
    results.push({ key: 'swap', value: pct, unit: '%', status: st, reason: st === 'ok' ? undefined : `swap ${pct} % in use` });
  }
  return results;
}

export function createMemoryCheck({ readMeminfo = () => readFile('/proc/meminfo', 'utf8') } = {}) {
  return {
    name: 'memory',
    required: [],
    optional: Object.keys(DEFAULTS),
    validate(params) {
      return [
        ...Object.keys(DEFAULTS).flatMap((k) => checkNumber(params, k, { min: 0, max: 100 })),
        ...checkOrder({ ...DEFAULTS, ...params }, 'ram_warn_percent', 'ram_crit_percent'),
        ...checkOrder({ ...DEFAULTS, ...params }, 'swap_warn_percent', 'swap_crit_percent'),
      ];
    },
    async measure(params) {
      let text;
      try {
        text = await readMeminfo();
      } catch (e) {
        const reason = `/proc/meminfo not readable: ${e.message}`;
        return [unknown('ram', reason), unknown('swap', reason)];
      }
      return evaluate(text, params);
    },
  };
}

export default createMemoryCheck();
