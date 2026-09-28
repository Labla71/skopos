// State machine of the collector. One entity per host-level finding (`host`), per check key
// (`check`: warn/crit against ok) and per check key's measurability (`measurement`: unknown
// against measured). Concepts borrowed from classic pull monitors:
//   soft/hard state  - a problem is confirmed only after N consecutive runs that are not ok
//   state changes    - only confirmed changes produce an event, never a steady state
//   recovery         - confirmed back to ok (again over N runs) produces an event
//   host dependency  - while a host is unreachable or its heartbeat is stale, events of its
//                      checks are held back; a problem that recovered meanwhile is dropped
//   flapping         - K confirmed changes within a window produce one "unstable" event and
//                      silence the entity until it has calmed down
//   throttling       - at most M problem notifications per hour, the rest as "throttled"
// Checks are rated per Skopos run in the history, not per poll: confirmation does not depend
// on how often the collector asks. Host-level findings are rated per poll.
import { MAX_RUNS } from './config.js';
import { heartbeatFindings, interpretFetch, nextWatermark, normalizeWatermark } from './fetch.js';

export const STATE_VERSION = 1;
export const EVENT_VERSION = 1;
// Only these host findings mean "the host does not deliver fresh data": they hold back the
// events of its checks. Other report errors carry no check data anyway.
export const HOST_DOWN_CODES = new Set(['host_unreachable', 'heartbeat_stale', 'heartbeat_missing']);
const MAX_RECENT = MAX_RUNS;
const MIN = 60_000;

// Run counts for one check key. Most specific wins: "check/key" (exact, with sub-key) over
// "check/instance" (the key before the first ".") over "check" (the whole module). Event
// counters (an OOM kill, a new journal error, a new 429) show up in one run only and need
// confirm_runs 1; a module-wide override would be too coarse for sqlite-query, which serves
// both event counters and steady values.
export function overrideFor(cfg, check, key) {
  const o = cfg.overrides ?? {};
  const instance = String(key).split('.')[0];
  return { ...o[check], ...o[`${check}/${instance}`], ...o[`${check}/${key}`] };
}

export const emptyState = () => ({ state_version: STATE_VERSION, watermarks: {}, entities: {}, pending: [], notified: [], seq: 0 });

function newEntity(id, meta) {
  return { id, ...meta, confirmed: false, recent: [], flips: [], unstable: false, last_time: null, streak: null, worst: null };
}

// kind: 'ok' | 'bad' | null. Neutral (unknown for a threshold check) confirms nothing and
// recovers nothing: "unknown" is never "ok".
function observe(state, ent, kind, atIso, rp, detail) {
  if (kind === null) return;
  if (kind === 'bad') {
    ent.streak ??= { first_seen: atIso, count: 0 };
    ent.streak.count += 1;
    ent.streak.last_seen = atIso;
    ent.streak.last = detail;
    if (detail?.status === 'crit' || (detail?.status === 'warn' && ent.worst !== 'crit')) ent.worst = detail.status;
  } else if (!ent.confirmed) {
    ent.streak = null; // an unconfirmed spike is forgotten
    ent.worst = null;
  }
  ent.recent.push(kind);
  if (ent.recent.length > MAX_RECENT) ent.recent.shift();
  const tail = (n) => ent.recent.length >= n && ent.recent.slice(-n).every((k) => k === kind);
  const need = detail?.status === 'crit' && rp.crit_confirm ? Math.min(rp.confirm, rp.crit_confirm) : rp.confirm;

  if (!ent.confirmed && kind === 'bad' && tail(need)) {
    ent.confirmed = true;
    ent.confirm_after = need;
    transition(state, ent, atIso, rp, 'problem');
  } else if (ent.confirmed && kind === 'ok' && tail(rp.recover)) {
    ent.confirmed = false;
    transition(state, ent, atIso, rp, 'recovery');
    ent.streak = null;
    ent.worst = null;
  }
}

function pruneFlips(ent, refMs, cfg) {
  ent.flips = ent.flips.filter((t) => t > refMs - cfg.flap_window_minutes * MIN);
}

function transition(state, ent, atIso, cfg, type) {
  const atMs = Date.parse(atIso);
  ent.flips.push(atMs);
  pruneFlips(ent, atMs, cfg);
  if (ent.unstable) return; // silent while unstable
  if (ent.flips.length >= cfg.flap_changes) {
    ent.unstable = true;
    // Whatever of this entity was not delivered yet is replaced by the one "unstable" event.
    state.pending = state.pending.filter((a) => a.entity !== ent.id);
    enqueue(state, ent, 'unstable', atIso, cfg);
    return;
  }
  enqueue(state, ent, type, atIso, cfg);
}

// The event is a snapshot taken at the transition, not at delivery: if the notifier is down
// for hours, it still describes the state at the time of the change.
export function buildEvent(ent, type, atIso, cfg, id) {
  const s = ent.streak ?? {};
  const ev = {
    event_version: EVENT_VERSION, id, type, time: atIso, host: ent.host, kind: ent.kind, code: ent.code,
    ...(ent.check !== undefined ? { check: ent.check, key: ent.key } : {}),
    ...(ent.extra ?? {}),
    confirmed: ent.confirmed,
    severity: ent.worst ?? (ent.kind === 'measurement' ? 'unknown' : null),
    first_seen: s.first_seen ?? null, last_seen: s.last_seen ?? null, count: s.count ?? 0,
    confirm_after: ent.confirm_after ?? null,
    last: s.last ?? null,
  };
  if (type === 'unstable' || type === 'calm') ev.flapping = { changes: ent.flips.length, limit: cfg.flap_changes, window_minutes: cfg.flap_window_minutes };
  ev.summary = summarize(ev);
  return ev;
}

const subjectOf = (ev) => (ev.kind === 'host' ? ev.code : ev.kind === 'measurement' ? `${ev.key} (not measuring)` : ev.key);

export function summarize(ev) {
  const what = `${ev.host} ${subjectOf(ev)}`;
  return {
    problem: `${what}: problem confirmed (${ev.severity ?? ev.code}, ${ev.count} observations since ${ev.first_seen})`,
    recovery: `${what}: ok again since ${ev.time}`,
    unstable: `${what}: unstable, ${ev.flapping?.changes} changes within ${ev.flapping?.window_minutes} min`,
    calm: `${what}: calmed down, current state ${ev.confirmed ? 'problem' : 'ok'}`,
  }[ev.type];
}

function enqueue(state, ent, type, atIso, cfg) {
  state.seq += 1;
  state.pending.push({ entity: ent.id, attempts: 0, event: buildEvent(ent, type, atIso, cfg, state.seq) });
}

// End of every poll: old changes expire; without changes in the window the entity has calmed
// down, and its final state follows as a regular problem or recovery event.
function settle(state, ent, now, cfg) {
  pruneFlips(ent, now.getTime(), cfg);
  if (ent.unstable && ent.flips.length === 0) {
    ent.unstable = false;
    const at = now.toISOString();
    enqueue(state, ent, 'calm', at, cfg);
    enqueue(state, ent, ent.confirmed ? 'problem' : 'recovery', at, cfg);
  }
}

function ensure(state, id, meta) {
  return (state.entities[id] ??= newEntity(id, meta));
}

// Feeds one poll of one host into the state. `res` is the raw result of the fetch.
export function processPoll(state, host, res, cfg, now = new Date()) {
  const fetched = interpretFetch(res);
  const summary = { host: host.name, complete: fetched.ok, rows: 0 };
  const nowIso = now.toISOString();

  // ---- host level, rated per poll
  const hostRp = (code) => {
    // Skopos already smooths freshness (stale only after two intervals): confirm at once.
    const n = code === 'heartbeat_stale' || code === 'heartbeat_missing' ? 1 : cfg.host_confirm_polls;
    return { ...cfg, confirm: n, recover: n };
  };
  // A different exit code or report version is a different finding (its own entity).
  const variant = (f) => (f.exit_code !== undefined && f.code === 'report_exit' ? `${f.code}:${f.exit_code}` : f.code === 'report_version' ? `${f.code}:${JSON.stringify(f.report_version)}` : f.code);
  const found = new Map((fetched.ok ? heartbeatFindings(fetched.report) : [fetched.finding]).map((f) => [variant(f), f]));
  for (const [v, f] of found) {
    const ent = ensure(state, `${host.name}|host|${v}`, { host: host.name, kind: 'host', code: f.code, variant: v });
    const { code, message, ...extra } = f;
    ent.extra = extra; // exit_code, report_version
    observe(state, ent, 'bad', nowIso, hostRp(code), { status: 'crit', message });
  }
  for (const ent of Object.values(state.entities)) {
    if (ent.host !== host.name || ent.kind !== 'host' || found.has(ent.variant ?? ent.code)) continue;
    // A complete fetch without this finding is "ok". A failed fetch where the host answered
    // (e.g. exit 1) disproves "unreachable" and any other report error; heartbeat findings
    // stay open, they need a complete report.
    const answered = !fetched.ok && fetched.finding.code !== 'host_unreachable';
    const recovers = fetched.ok || (answered && (ent.code === 'host_unreachable' || ent.code.startsWith('report_')));
    if (recovers) observe(state, ent, 'ok', nowIso, hostRp(ent.code), null);
  }

  // ---- check level, rated per Skopos run; only from a complete fetch
  if (fetched.ok) {
    const { report } = fetched;
    const groups = new Map();
    for (const row of report.history) {
      const k = `${row.check}\u0000${row.key}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    }
    for (const rows of groups.values()) {
      rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      const { check, key } = rows[0];
      const ov = overrideFor(cfg, check, key);
      const recover = ov.recover_runs ?? cfg.recover_runs;
      const chkRp = { ...cfg, confirm: ov.confirm_runs ?? cfg.confirm_runs, recover, crit_confirm: ov.crit_confirm_runs };
      const unkRp = { ...cfg, confirm: cfg.unknown_confirm_runs, recover };
      const meta = { host: host.name, check, key };
      const chk = ensure(state, `${host.name}|check|${check}|${key}`, { ...meta, kind: 'check', code: 'check_problem' });
      const unk = ensure(state, `${host.name}|measurement|${check}|${key}`, { ...meta, kind: 'measurement', code: 'check_unknown' });
      for (const row of rows) {
        if (chk.last_time && row.time <= chk.last_time) continue; // already seen (overlap)
        summary.rows += 1;
        const detail = { status: row.status, value: row.value ?? null, unit: row.unit ?? null, reason: row.reason ?? null, time: row.time };
        observe(state, chk, row.status === 'ok' ? 'ok' : row.status === 'unknown' ? null : 'bad', row.time, chkRp, detail);
        observe(state, unk, row.status === 'unknown' ? 'bad' : 'ok', row.time, unkRp, detail);
        chk.last_time = unk.last_time = row.time;
      }
    }
    const next = nextWatermark(report, normalizeWatermark(state.watermarks[host.name]));
    if (next) state.watermarks[host.name] = next;
  }

  for (const ent of Object.values(state.entities)) if (ent.host === host.name) settle(state, ent, now, cfg);
  return summary;
}

export const hostDown = (state, hostName) => Object.values(state.entities)
  .some((e) => e.host === hostName && e.kind === 'host' && e.confirmed && HOST_DOWN_CODES.has(e.code));

// Delivers `pending` in order through `notifier.notify(event)` (throws on failure). A failed
// event stays, together with all later events of the same entity, for the next poll.
export async function deliver(state, notifier, cfg, now = new Date()) {
  const stats = { sent: 0, throttled: 0, failed: 0, held: 0, dropped: 0 };
  const blocked = new Set();
  const remaining = [];
  dropRecoveredWhileHeld(state, stats);
  for (const item of state.pending) {
    const ent = state.entities[item.entity];
    if (!ent) { stats.dropped += 1; continue; }
    if (blocked.has(ent.id)) { remaining.push(item); continue; }
    // Held while the host was down, and the fresh data after its return look ok: wait until the
    // recovery is confirmed (then both are dropped) or the problem shows again.
    const recovering = item.held && item.event.type === 'problem' && ent.recent.at(-1) === 'ok';
    if (ent.kind !== 'host' && (recovering || hostDown(state, ent.host))) {
      item.held = true;
      stats.held += 1;
      blocked.add(ent.id);
      remaining.push(item);
      continue;
    }
    try {
      await deliverOne(state, notifier, cfg, item, now, stats);
    } catch (e) {
      item.attempts += 1;
      item.error = String(e?.message ?? e).slice(0, 300);
      blocked.add(ent.id);
      stats.failed += 1;
      remaining.push(item);
    }
  }
  state.pending = remaining;
  return stats;
}

// A check problem held back while its host was down and recovered meanwhile is noise.
function dropRecoveredWhileHeld(state, stats) {
  const drop = new Set();
  state.pending.forEach((item, i) => {
    if (!item.held || item.event.type !== 'problem' || hostDown(state, state.entities[item.entity]?.host)) return;
    const j = state.pending.findIndex((o, k) => k > i && o.entity === item.entity && o.event.type === 'recovery' && !drop.has(o));
    if (j >= 0) { drop.add(item); drop.add(state.pending[j]); }
  });
  if (drop.size) {
    state.pending = state.pending.filter((x) => !drop.has(x));
    stats.dropped += drop.size;
  }
}

async function deliverOne(state, notifier, cfg, item, now, stats) {
  const { event } = item;
  if (event.type === 'problem' || event.type === 'unstable') {
    state.notified = state.notified.filter((t) => t > now.getTime() - 60 * MIN);
    if (state.notified.length >= cfg.max_notifications_per_hour) {
      await notifier.notify({ event_version: EVENT_VERSION, id: event.id, type: 'throttled', time: now.toISOString(), limit_per_hour: cfg.max_notifications_per_hour, suppressed: event, summary: `throttled: ${event.summary}` });
      stats.throttled += 1;
      return;
    }
    await notifier.notify(event);
    state.notified.push(now.getTime());
  } else {
    await notifier.notify(event);
  }
  stats.sent += 1;
}
