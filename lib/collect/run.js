// One poll of the collector: load state -> fetch all hosts in parallel -> feed the state
// machine -> deliver pending events -> save state. Watermarks and state advance together at
// the very end; if the process dies in between, the next poll repeats this one.
import { execHost, normalizeWatermark } from './fetch.js';
import { deliver, emptyState, processPoll } from './machine.js';

const MIN = 60_000;

export async function collectOnce({ cfg, store, notifier, exec = execHost, now = new Date() }) {
  const state = (await store.load()) ?? emptyState();
  const results = await Promise.all(cfg.hosts.map(async (host) => {
    // First poll of a host: not the whole default window, or long-gone problems would be reported.
    state.watermarks[host.name] ??= new Date(now.getTime() - cfg.initial_lookback_minutes * MIN).toISOString();
    const since = normalizeWatermark(state.watermarks[host.name]);
    const args = ['report', '--json', ...(since ? ['--since', since] : [])];
    try {
      return { host, res: await exec(host, args, { timeoutMs: cfg.fetch_timeout_seconds * 1000 }) };
    } catch (e) {
      return { host, res: { code: null, timedOut: false, stdout: '', stderr: String(e?.message ?? e) } };
    }
  }));
  const hosts = results.map(({ host, res }) => processPoll(state, host, res, cfg, now));
  const stats = await deliver(state, notifier, cfg, now);
  await store.save(state);
  const problems = Object.values(state.entities).filter((e) => e.confirmed).length;
  return { hosts, stats, pending: state.pending.length, problems, errors: state.pending.filter((p) => p.error).map((p) => p.error) };
}

export function formatPoll(r) {
  const hosts = r.hosts.map((h) => `${h.host}=${h.complete ? `ok/${h.rows}` : 'failed'}`).join(' ');
  const s = r.stats;
  return `collect: ${hosts} | problems=${r.problems} sent=${s.sent} throttled=${s.throttled} held=${s.held} dropped=${s.dropped} failed=${s.failed} pending=${r.pending}`;
}
