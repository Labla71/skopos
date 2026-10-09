// Human-readable report (`skopos report` without --json). The JSON report stays the interface
// for the collector; this view is for people at a terminal. Meaning never rests on colour alone:
// every status is a word, problems come first.
const ORDER = { crit: 0, warn: 1, unknown: 2, ok: 3 };
const LABEL = { crit: 'CRIT', warn: 'WARN', unknown: 'UNKNOWN', ok: 'ok' };

function ago(seconds) {
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

export function formatReport(report) {
  const hb = report.heartbeat;
  if (!hb) return 'No run recorded yet. Run `skopos run` first.';
  const { ok, warn, crit, unknown } = hb.counts;
  const stale = hb.stale === true ? ' - STALE: no fresh run' : hb.stale === null ? ' - freshness unknown' : '';
  const lines = [
    `Skopos ${hb.version} - last run ${ago(hb.age_seconds)} (every ${hb.interval_minutes ?? '?'} min)${stale}`,
    `ok ${ok} | warn ${warn} | crit ${crit} | unknown ${unknown}`,
    '',
  ];
  const rows = report.checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => ORDER[a.c.status] - ORDER[b.c.status] || a.i - b.i)
    .map(({ c }) => ({
      status: LABEL[c.status] ?? c.status,
      key: c.key,
      value: c.value === null || c.value === undefined ? '' : `${c.value}${c.unit ? ` ${c.unit}` : ''}`,
      reason: c.reason ?? '',
    }));
  const width = (f, min) => Math.max(min, ...rows.map((r) => r[f].length));
  const w = { status: width('status', 6), key: width('key', 5), value: width('value', 5) };
  const row = (r) => `${r.status.padEnd(w.status)}  ${r.key.padEnd(w.key)}  ${r.value.padEnd(w.value)}  ${r.reason}`.trimEnd();
  lines.push(row({ status: 'STATUS', key: 'CHECK', value: 'VALUE', reason: 'REASON' }));
  for (const r of rows) lines.push(row(r));
  return lines.join('\n');
}
