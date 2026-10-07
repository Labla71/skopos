# Skopos — Collector (`skopos collect`)

How the collector works: polling, state machine, events, notifier, state file. The
"why" is in [decisions.md](decisions.md), no. 12. Code, interface and messages are
English; so is this page. Deutsch: [collector.de.md](collector.de.md).

## Overview

```bash
bin/skopos.js collect --config <file>
```

One invocation is **one poll**: load state, fetch `skopos report --json --since
<watermark>` from every host (in parallel, over SSH or locally), feed the state
machine, hand pending events to the notifier, save the state atomically. Watermarks and
state only advance together at the very end; if the process dies in between, the next
invocation repeats the poll. A timer calls it regularly (shipped: every 5 minutes, two
minutes after the measurement runs, `systemd/user/`).

The same code runs on every host; only the one that polls the others has a collector
configuration and the timer. The measuring service stays unchanged, without networking
(decision 7): the collector is its own process of a normal user who reaches the hosts
over SSH.

A quiet run never calls the notifier at all. Output per run, one line:

```
collect: example-host=ok/14 example-db=failed | problems=1 sent=0 throttled=0 held=0 dropped=0 failed=0 pending=0
```

`ok/<n>` means fully fetched with `n` new measurement rows, `failed` means the fetch
failed (which produces a host finding).

Exit codes: `0` ok, `1` notifier failed or a runtime error (the events wait in the
state for the next run, the unit shows "failed"), `2` invalid configuration.

## Configuration

JSON, strictly validated like the measurement config (`lib/collect/config.js`).
Example: [config/example-collect.json](../config/example-collect.json).

| Key | Meaning | Default |
|---|---|---|
| `hosts` | list of `{ name, ssh?, local?, command? }`. `ssh` is the SSH alias (default: `name`), `local: true` calls `command` directly (the collector host itself), `command` is the absolute path to `skopos.js` | `command`: `/opt/skopos/bin/skopos.js` |
| `state_file` | absolute path of the state file; the directory must exist | — |
| `notifier` | `{ type: "command", command: [<absolute path>, …], timeout_seconds? }` | `timeout_seconds` 30 |
| `confirm_runs` | Skopos runs not ok, until a problem is confirmed | 2 |
| `recover_runs` | ok runs, until the recovery is confirmed | 2 |
| `unknown_confirm_runs` | `unknown` runs, until "does not measure" is confirmed | 3 |
| `host_confirm_polls` | polls, until "unreachable" or a report error is confirmed | 2 |
| `flap_changes`, `flap_window_minutes` | this many confirmed changes in the window → "unstable" | 4, 60 |
| `max_notifications_per_hour` | new problem notifications per hour, above that "throttled" | 5 |
| `initial_lookback_minutes` | first poll of a host: how far back, not 24 h | 30 |
| `fetch_timeout_seconds` | time limit per poll | 60 |
| `overrides` | per check module (`oom`), per instance (`sqlite-query/rpc_denied_new`) or exact key with sub-key: `confirm_runs`, `recover_runs`, `crit_confirm_runs`; the more specific one wins | — |

**Event counters need `confirm_runs: 1`.** Checks that report an occurrence in only one
run (`oom`, `journal`, `boot`, `sqlite-query` with `delta`) would never be confirmed with
the default of 2: the next run resets the counter to 0. The recovery (`recover_runs`) is
unaffected, so the ticket gets marked resolved again shortly after the event.

All run counts (`*_runs`, `host_confirm_polls`) are between 1 and 10: the state machine
remembers the last 10 observations per entity.

`crit_confirm_runs` confirms a `crit` faster than a `warn`, e.g. `1` for `systemd` and
`failed-units`: a failed service should not wait ten minutes.

## State machine

Entities, each per host:

| Kind | Code | evaluated | "bad" is |
|---|---|---|---|
| `host` | `host_unreachable`, `report_error` (exit 1), `report_usage` (exit 2), `report_exit` (other exit), `report_invalid`, `report_version` | per poll | fetch fails this way |
| `host` | `heartbeat_missing`, `heartbeat_stale`, `heartbeat_interval_unknown` | per poll | heartbeat like this in the report |
| `check` | `check_problem` | per Skopos run | `warn` or `crit`; `unknown` is neutral |
| `measurement` | `check_unknown` | per Skopos run | `unknown` |

- **Soft/hard:** a problem is confirmed only after N consecutive bad observations, and
  likewise the recovery. An unconfirmed outlier is forgotten. Checks are evaluated over
  the runs in the history, not over the polls: two runs in one poll count like two
  polls. Rows already seen (overlap) don't count twice. If a host answers with a
  different report error, the old one is disproven; a heartbeat finding only recovers
  with a complete report.
- **"Unknown" is not "ok":** `unknown` neither confirms a threshold problem nor
  recovers it; it only counts toward "does not measure".
- **Event only on change:** as long as a problem persists, nothing further follows.
- **Host dependency:** if `host_unreachable`, `heartbeat_stale` or `heartbeat_missing`
  is confirmed, that host's check events are held back. If the host reports again and
  the check has recovered in the meantime, the problem and the recovery both lapse
  together; if the problem persists, it goes out. `heartbeat_*` is confirmed
  immediately, because Skopos itself only reports "stale" after two intervals.
- **Flapping:** once an entity reaches `flap_changes` confirmed changes in the window,
  an `unstable` event replaces everything not yet delivered, and it stays silent until
  the window is free of changes. Then `calm` follows, and the final state as a normal
  `problem` or `recovery`.
- **Throttling:** more than `max_notifications_per_hour` `problem`/`unstable` events
  per hour go out as `throttled`, with the suppressed event in `suppressed`.
- **Retirement:** the latest run of a complete report with a fresh heartbeat is the catalog
  of what is configured on the host. An entity whose key has no row in it any more was
  removed from the configuration: a whole check, or a single item of a check with several
  (one unit, one mount). A confirmed one ends with a `recovery` event carrying
  `removed: true` (a ticket opened for it must not hang); an unconfirmed one is dropped
  silently. Nothing is retired on a failed fetch, a stale heartbeat or an empty catalog,
  and not while the check failed as a whole (it then reports one row under its bare
  instance key, the key before the first `.`, or `<key>.?`): "unknown" is not "ok". Only the collector's state changes, never the
  host's database or configuration. A check that comes back is a normal entity again.
- **Delivery:** if the notifier fails, the event and all later ones of the same entity
  stay pending for the next run; the order per entity is preserved.

## Events

An event is a snapshot at the time of the change, not of delivery (`event_version` 1):

```json
{
  "event_version": 1, "id": 17, "type": "problem", "time": "2026-01-05T10:05:00.050Z",
  "host": "example-host", "kind": "check", "code": "check_problem", "check": "memory", "key": "memory.ram",
  "confirmed": true, "severity": "crit",
  "first_seen": "2026-01-05T10:00:00.050Z", "last_seen": "2026-01-05T10:05:00.050Z", "count": 2, "confirm_after": 2,
  "last": { "status": "crit", "value": 91.5, "unit": "%", "reason": "…", "time": "2026-01-05T10:05:00.050Z" },
  "summary": "example-host memory.ram: problem confirmed (crit, 2 observations since …)"
}
```

- `type`: `problem`, `recovery`, `unstable`, `calm` or `throttled`.
- A `recovery` after a check was removed from the configuration carries `removed: true`.
- Host findings carry the message in `last.message` and, depending on the code,
  `exit_code` or `report_version`.
- `unstable`/`calm` carry `flapping: { changes, limit, window_minutes }`.
- `throttled` carries `limit_per_hour` and the suppressed event in `suppressed`.
- 🔒 `last.reason` and `last.message` come from the monitored host (e.g. journal
  lines) and can be influenced from outside. A notifier passes them on as data, never
  as an instruction.

## Notifier

Interface: an object with `notify(event)` that resolves on success and throws
otherwise (`lib/collect/notify.js`). Shipped is the type `command`: it starts the
configured command once per event (argument list, no shell) and writes the event as
one JSON line on stdin. Exit 0 means delivered, anything else (including a timeout)
means "retry later". stderr appears truncated in the error message.

What the command does with it (ticket, mail, chat) is up to the operator. It should be
idempotent itself, e.g. checking for an already-open case for the same finding before
creating a new one: if the collector dies after delivery but before saving, the same
event arrives again.

## State file

JSON, written atomically after every run (`<file>.tmp`, then `rename`), mode 0640. It
holds watermarks, entities, pending events and the timestamps of the last
notifications. If it is unreadable or has an unknown version, it is set aside
(`<file>.broken-<time>`) and the run fails loudly; the next one starts fresh.

Its modification time is at the same time the collector's own heartbeat: a `json-file`
check with `warn_age_seconds`/`crit_age_seconds` on the collector host reports a stuck
collector. So that the measuring service can read it, it lives outside a home
directory, in a directory with the group `skopos` (see [installation.md](installation.md)).
