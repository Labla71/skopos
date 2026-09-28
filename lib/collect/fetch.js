// Fetching a report from a host and turning the outcome into host-level findings.
// Every way a fetch can fail is its own named finding ("unknown" is not "ok"); only a
// complete fetch yields check data: exit 0, valid JSON, known report version.
// The collector reaches other hosts only through the ssh binary; the measuring side stays
// without network (decision 7), and this module opens no socket itself.
import { execFile } from 'node:child_process';
import { REPORT_VERSION } from '../report.js';

const STATUSES = new Set(['ok', 'warn', 'crit', 'unknown']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const clip = (s, n = 300) => String(s ?? '').trim().slice(0, n);
const finding = (code, message, extra = {}) => ({ code, message, ...extra });

// Only a strict ISO time is accepted (it ends up on a remote command line); otherwise null.
export function normalizeWatermark(value) {
  if (typeof value !== 'string' || !ISO.test(value)) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// The next watermark is the end of the last stored run plus 1 ms, not generated_at: a run that
// is still in progress during the fetch stores rows with earlier timestamps at its end.
export function nextWatermark(report, previous) {
  const fin = normalizeWatermark(report.heartbeat?.finished_at);
  return fin ? new Date(Date.parse(fin) + 1).toISOString() : previous;
}

function shapeProblem(r) {
  if (typeof r.generated_at !== 'string' || Number.isNaN(Date.parse(r.generated_at))) return 'generated_at missing or invalid';
  if (!('heartbeat' in r)) return 'heartbeat missing';
  if (!Array.isArray(r.checks) || !Array.isArray(r.history)) return 'checks/history are not lists';
  for (const row of [...r.checks, ...r.history]) {
    if (row === null || typeof row !== 'object' || typeof row.key !== 'string' || typeof row.check !== 'string'
      || typeof row.time !== 'string' || !STATUSES.has(row.status)) return `row without valid check/key/status/time: ${JSON.stringify(row).slice(0, 100)}`;
  }
  return null;
}

// { ok: true, report } or { ok: false, finding }. `res` = { code, timedOut, stdout, stderr }.
export function interpretFetch(res) {
  const err = clip(res.stderr);
  if (res.timedOut || res.code === 255 || res.code === null) {
    return { ok: false, finding: finding('host_unreachable', res.timedOut ? 'timeout while fetching the report' : `connection failed (exit ${res.code}): ${err}`) };
  }
  if (res.code === 1) return { ok: false, finding: finding('report_error', `report exited with 1 (runtime error, e.g. database missing): ${err}`, { exit_code: 1 }) };
  if (res.code === 2) return { ok: false, finding: finding('report_usage', `report exited with 2 (invalid arguments or configuration): ${err}`, { exit_code: 2 }) };
  if (res.code !== 0) return { ok: false, finding: finding('report_exit', `report exited with ${res.code}: ${err}`, { exit_code: res.code }) };
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch (e) {
    return { ok: false, finding: finding('report_invalid', `not valid JSON: ${e.message}; output starts with: ${clip(res.stdout, 120)}`) };
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return { ok: false, finding: finding('report_invalid', 'root is not an object') };
  if (report.report_version !== REPORT_VERSION) {
    return { ok: false, finding: finding('report_version', `report version ${JSON.stringify(report.report_version)} is unknown (supported: ${REPORT_VERSION})`, { report_version: report.report_version ?? null }) };
  }
  const shape = shapeProblem(report);
  if (shape) return { ok: false, finding: finding('report_invalid', `structure violated: ${shape}`) };
  return { ok: true, report };
}

// Host-level findings from a complete report: the heartbeat.
export function heartbeatFindings(report) {
  const hb = report.heartbeat;
  if (hb === null) return [finding('heartbeat_missing', 'Skopos never ran on this host (no run in the database).')];
  if (hb.stale === true) {
    return [finding('heartbeat_stale', `last run ${Math.round(hb.age_seconds / 60)} min ago (${hb.finished_at}), interval ${hb.interval_minutes} min: more than two intervals without a run.`)];
  }
  if (hb.stale !== false) return [finding('heartbeat_interval_unknown', `the last run does not know its interval (stale=${JSON.stringify(hb.stale)}); freshness cannot be judged.`)];
  return [];
}

// Process call for a host: `local` runs the command directly, otherwise over SSH. No shell on
// this side; the remote side gets a command line of validated parts only.
export function buildCommand(host, args) {
  if (host.local) return { file: host.command, args };
  return { file: 'ssh', args: ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '--', host.ssh, [host.command, ...args].join(' ')] };
}

export function execHost(host, args, { timeoutMs }) {
  const { file, args: argv } = buildCommand(host, args);
  return new Promise((resolve) => {
    execFile(file, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      timedOut: Boolean(error?.killed), stdout, stderr: stderr || (error && typeof error.code !== 'number' ? error.message : ''),
    }));
  });
}
