# Skopos — Core

How the core works: configuration, check interface, storage, heartbeat, report. The
"why" is in [concept.md](concept.md) and [decisions.md](decisions.md). Code, interface
and messages are English; so is this page. Deutsch: [core.de.md](core.de.md).

## Invocation

```bash
bin/skopos.js run    [--config <file>] [--db <file>]
bin/skopos.js report [--json] [--since <ISO timestamp>] [--db <file>]
bin/skopos.js collect --config <file>
```

`collect` is the collector, which pulls other hosts' reports and reports confirmed
state changes: [collector.md](collector.md).

Call the script directly, not via `node bin/skopos.js`: only then does the
`--disable-warning=ExperimentalWarning` switch from the first line take effect,
otherwise the `node:sqlite` warning can appear on stderr depending on run duration.
This also applies to the systemd unit and to fetching over SSH.

Defaults: config `/etc/skopos/config.json`, database `/var/lib/skopos/skopos.db`
(redirectable via `--db` or the `SKOPOS_DB` environment variable). Exit codes: `0` ok,
`1` runtime error (e.g. database missing on report), `2` invalid configuration or
arguments.

## Configuration

JSON, strictly validated (`lib/config.js`); all errors are collected and reported
together. Comments only in the `_comment` field.

| Key | Meaning | Default |
|---|---|---|
| `checks` | list of checks, at least one (required) | — |
| `interval_minutes` | timer cadence; the installer sets the timer to it, the core writes it into the heartbeat so the report can evaluate `stale` | 5 |
| `retention_days` | retention of runs and measurements | 30 |
| `timeout_seconds` | time limit per check | 30 |

Each entry in `checks` has `check` (name of the check module), `key` (instance name,
`A-Z a-z 0-9 _ -`, unique per check), optionally `timeout_seconds` and `_comment`, plus
the check's parameters. Unknown checks, unknown keys and missing required values abort;
names like `toString` or `__proto__` count as unknown. Examples: `config/example*.json`.

## Check interface

A check is a module in `lib/checks/` and an entry in `lib/checks/index.js`:

```js
export default {
  name: 'example',
  required: ['file'],         // required parameters from the config
  optional: ['warn_above'],   // further allowed parameters
  validate(params) { return []; },               // optional: error messages
  async measure(params, ctx) {                   // returns a result or a list of them
    return [{ key: 'part', value: 1, unit: 's', status: 'ok', reason: undefined }];
  },
};
```

- `status` is `ok`, `warn`, `crit` or `unknown`. `value` is a finite number or a
  string; for `unknown` it is absent, `reason` is then required.
- Several measurements of one check are distinguished by `key` (`A-Z a-z 0-9 _ -`);
  stored as `<instance>.<key>`. A different sub-key yields `unknown`.
- `ctx.signal` (AbortSignal) is aborted on timeout. `ctx.state.get(k)` and
  `ctx.state.set(k, value)` hold a watermark for "since the last run"; it only advances
  when the check completes normally. The value must be storable as JSON (`undefined`,
  functions and cycles are not): `set()` throws immediately otherwise, the check
  becomes `unknown`, and the rest of the run is unaffected.
- If a check throws, exceeds the time limit or returns something invalid, the core
  stores `unknown` with a reason. Other checks keep running. Checks run one after
  another and must work asynchronously: a synchronous long-running task cannot be
  interrupted.

Available: `uptime` (parameter `warn_below_seconds`, optional) as well as the system
checks `boot`, `memory`, `load`, `disk`, `oom`, `journal`, `failed-units`, `systemd` and
`mount`, plus the business checks `sqlite-query` and `json-file`, described in
[checks.md](checks.md).

## Storage

A module (`lib/store.js`) wraps `node:sqlite`. Its own database in journal mode
`DELETE`, file permissions `0644`. Schema version in `PRAGMA user_version` (currently
1). A run migrates an older database step by step (`MIGRATIONS`); the report opens
read-only and aborts with a hint on an older or newer version.

A run (timer) and a report (fetch) can overlap. Both sides then wait up to 10 seconds
(`busy_timeout`) instead of aborting with "database is locked".

- `runs` — heartbeat: `started_at`, `finished_at`, `duration_ms`, `count_<status>`,
  `version`, `interval_minutes`. Written at the end of a run together with the
  measurements in one transaction; an aborted run leaves no heartbeat, and that is
  exactly the finding.
- `measurements` — `run_id`, `time`, `check`, `key`, `value`, `unit`, `status`,
  `reason`.
- `state` — `check`, `key`, `value` (JSON); plus `skopos/last_prune`.

Retention: once every 24 hours the run deletes runs and measurements older than
`retention_days`.

## Report

`report` without `--json` prints a readable table for people: heartbeat line, counts and one
row per check, problems first (`CRIT`, `WARN`, `UNKNOWN`, then `ok`). Status is always a word,
never colour alone. The collector uses the JSON form.

`report --json` opens the database read-only and outputs (`report_version` 1):

- `heartbeat`: the last run (`run_id`, `started_at`, `finished_at`, `duration_ms`,
  `counts` per status, `version`, `age_seconds`, `interval_minutes`, `stale`,
  `runs_in_window`); `null` if no run ever happened. `stale` is `true` if more than
  two intervals have passed since the last run, and `null` if the run knows no
  interval.
- `checks[]`: measurements of the last run (`check`, `key`, `status`, `reason`,
  `value`, `unit`, `time`).
- `history[]`: all measurements since `--since` (default: the last 24 hours), same
  fields.

If the database is missing, the report aborts with exit code 1 instead of inventing an
empty output.

`history[]` contains raw rows, around 13,000 a day with 15 checks. An evaluator that
polls regularly therefore passes `--since` with the time of its last poll;
`skopos collect` does exactly that ([collector.md](collector.md)).
