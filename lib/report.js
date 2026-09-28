// Report: the stable interface for the collector (the database schema stays internal).
// "Compute first, then read": heartbeat age and staleness are already included.
export const REPORT_VERSION = 1;
const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
// A heartbeat is stale once more than two intervals have passed without a run.
export const STALE_AFTER_INTERVALS = 2;

export function buildReport(store, { since, now = new Date() } = {}) {
  const sinceIso = since ?? new Date(now.getTime() - DEFAULT_WINDOW_MS).toISOString();
  const run = store.lastRun();
  const age = run && Math.max(0, Math.round((now.getTime() - Date.parse(run.finished_at)) / 1000));
  const interval = run?.interval_minutes ?? null;
  const row = (m) => ({ check: m.check, key: m.key, status: m.status, reason: m.reason, value: m.value, unit: m.unit, time: m.time });
  return {
    report_version: REPORT_VERSION,
    generated_at: now.toISOString(),
    since: sinceIso,
    heartbeat: run && {
      run_id: run.id,
      started_at: run.started_at,
      finished_at: run.finished_at,
      duration_ms: run.duration_ms,
      age_seconds: age,
      interval_minutes: interval,
      // null if the run does not know its interval — "unknown" is not "ok".
      stale: interval === null ? null : age > STALE_AFTER_INTERVALS * interval * 60,
      counts: { ok: run.count_ok, warn: run.count_warn, crit: run.count_crit, unknown: run.count_unknown },
      version: run.version,
      runs_in_window: store.countRuns(sinceIso),
    },
    checks: run ? store.measurementsOfRun(run.id).map(row) : [],
    history: store.history(sinceIso).map(row),
  };
}
