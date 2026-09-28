# Skopos — Configuration examples

Recipes to get started: what does a config look like for a particular monitoring goal?
Each example is a self-contained, runnable excerpt of `checks` (embed it into your own
config file with `interval_minutes`, `retention_days`, `timeout_seconds`, see the
skeleton below). The full parameter list per check is in [checks.md](checks.md), the
configuration file's schema in [core.md](core.md), the project's "why" in
[concept.md](concept.md). This document replaces none of the three — it only shows how
to get started. Deutsch: [examples.de.md](examples.de.md).

The installer copies `doc/` along to `/opt/skopos/doc` — so this document also lives on
every installed target host itself and is readable there without a repo checkout, for
an LLM or a human who needs to configure the running installation.

For an LLM or a human configuring Skopos for the first time: a check is activated by an
entry in `checks`; every entry needs `check` (the module name from the table below) and
`key` (a freely chosen instance name). Several examples can be combined in one config
by putting their `checks` entries into one shared list — a full example with almost
every check lives at [../config/example.json](../config/example.json).

## Skeleton

```json
{
  "interval_minutes": 5,
  "retention_days": 30,
  "timeout_seconds": 30,
  "checks": []
}
```

`checks` is the only required field; the other three keys default to the values shown
above. A test run against a throwaway database:

```bash
bin/skopos.js run --config <your-file>.json --db /tmp/skopos.db
bin/skopos.js report --json --db /tmp/skopos.db
```

## RAM and CPU monitoring

```json
{ "check": "memory", "key": "memory", "ram_warn_percent": 90, "ram_crit_percent": 95 },
{ "check": "load", "key": "cpu", "warn_ratio": 1.5, "crit_ratio": 3 }
```

`memory` measures RAM and swap usage in percent (`/proc/meminfo`), `load` the load
average per core. Without any settings, the values shown above already apply as
defaults — the check works with just `{ "check": "memory", "key": "memory" }` too.
Details, including edge cases such as "no swap partition":
[checks.md](checks.md#memory) and [checks.md](checks.md#load).

## Disk usage

```json
{ "check": "disk", "key": "disk", "mounts": ["/", "/var"], "warn_percent": 85, "crit_percent": 95 }
```

`mounts` is required (absolute paths); each path produces its own measurement
(`disk./var` → key `var`). Details: [checks.md](checks.md#disk).

## Detecting reboots — including planned ones (updates)

```json
{ "check": "boot", "key": "boot" }
```

Reports every reboot of the machine exactly once, classified as `clean`/`unclean`
(an orderly shutdown recognized from the previous run's journal, or not). But a reboot
after a planned update shouldn't trigger a finding like a crash would: before the
planned reboot, once run

```bash
bin/skopos.js expect-reboot --reason "kernel update"
```

(e.g. in the update script, right before `reboot`). If the following reboot was
`clean` and the marker file is still fresh enough (default 30 minutes), `boot`
evaluates it as `ok` instead of a finding — without the config needing to know
anything about it. An `unclean` end (a crash) is unaffected. Details, including the
optional parameters `severity`, `unclean_severity`, `expected_max_age_minutes`:
[checks.md](checks.md#boot).

## Services and failed units

```json
{
  "check": "systemd",
  "key": "services",
  "boot_grace_seconds": 600,
  "restart_grace_seconds": 120,
  "units": [
    { "unit": "example-app.service", "expected": "active", "severity": "crit" },
    { "unit": "example-legacy.service", "expected": "inactive", "severity": "warn" }
  ]
},
{ "check": "failed-units", "key": "failed", "ignore": ["example-optional.service"] }
```

`systemd` checks an explicit list of units against the expected state (including that
a unit is deliberately *not* running). `boot_grace_seconds` tolerates the startup phase
after a reboot, `restart_grace_seconds` a controlled `systemctl restart`.
`failed-units` counts, machine-wide, all units in state `failed`, regardless of
whether they are in the `systemd` list — useful for timer jobs you don't want to list
individually. Details: [checks.md](checks.md#systemd), [checks.md](checks.md#failed-units).

## Errors in the journal

```json
{ "check": "journal", "key": "errors", "priority": "err", "exclude": ["^example noisy driver"], "severity": "warn" }
```

Counts journal entries at or above the given priority since the last run, optionally
restricted to units (`units: [...]`) and with exclusion patterns against known noise.
Details: [checks.md](checks.md#journal).

## Kernel OOM kills

```json
{ "check": "oom", "key": "oom", "severity": "crit" }
```

Counts processes killed by the kernel since the last run. Details:
[checks.md](checks.md#oom).

## Reachability of a mount (network share, FUSE)

```json
{ "check": "mount", "key": "mounts", "paths": ["/mnt/example"], "read_timeout_seconds": 5 }
```

Checks whether the path is a mount point and its directory is readable within the time
limit — a hanging network mount yields `crit`, not a blocked Skopos process. Details:
[checks.md](checks.md#mount).

## A business metric from a foreign SQLite database

```json
{ "check": "sqlite-query", "key": "queue_length", "database": "/var/lib/example-app/app.db",
  "query": "SELECT COUNT(*) FROM jobs WHERE state = 'pending'", "unit": "jobs",
  "warn_above": 100, "crit_above": 1000 }
```

A snapshot example (current queue length). For a counter that should only ever
increase (e.g. errors per day), `delta: true` measures the increase since the last
run:

```json
{ "check": "sqlite-query", "key": "errors_total", "database": "/var/lib/example-app/app.db",
  "query": "SELECT SUM(errors) FROM daily_stats", "null_as": 0,
  "delta": true, "on_decrease": "rebase", "unit": "errors",
  "warn_above": 1, "crit_above": 20 }
```

The connection is always read-only, regardless of the query. `on_decrease` decides how
a falling value is interpreted (`"restart"` for a counter that genuinely restarts
periodically, `"rebase"` for a sum that really should never fall). Details, including
the safeguard against writing queries: [checks.md](checks.md#business-checks-sqlite-query-and-json-file)
and [checks.md](checks.md#sqlite-query).

## A business metric from a JSON file

```json
{ "check": "json-file", "key": "last_run", "file": "/var/lib/example-app/last-run.json",
  "field": "status", "expected": "ok", "warn_age_seconds": 172800 }
```

Reads a field (a dot path is possible, e.g. `result.status`) and additionally
evaluates the file age — useful for "did the last cron/batch job succeed, and in
time?". Details: [checks.md](checks.md#json-file).

## Uptime as a simple alternative to `boot`

```json
{ "check": "uptime", "key": "uptime", "warn_below_seconds": 300 }
```

Reports a finding as long as the machine has been up for less than the given time —
simpler than `boot`, but without a planned/unplanned distinction and without a
one-shot event (the finding persists as long as the uptime is below the threshold).
For most cases, `boot` is the better choice.

## Maintaining this document

`test/doc.test.js` checks on every `npm test` that every check from
`lib/checks/index.js` is named here — a new check without an example fails the tests
instead of letting the docs quietly go stale. A new parameter on an existing check
doesn't fail the test, but still belongs in this document or in
[checks.md](checks.md) once it matters for getting started.
