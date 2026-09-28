# Skopos — System checks

The generic checks that make sense on any Linux machine. Structure and interface are in
[core.md](core.md), the "why" in [concept.md](concept.md). Parameters and messages are
English; full example: `config/example.json`; individual, annotated recipes by
monitoring goal: [examples.md](examples.md). Deutsch: [checks.de.md](checks.de.md).

Shared: all checks are read-only. If a check cannot measure (source missing, command
fails, output unusable), it stores `unknown` with a reason, never a zero. Thresholds
apply "at or above" (`≥`). The tests inject the sources (`/proc` text, command output);
they never read anything live.

| Check | Key (`<key>.<part>`) | Value |
|---|---|---|
| `boot` | `reboots` | 1 in the run after a machine reboot, else 0 |
| `memory` | `ram`, `swap` | usage in % |
| `load` | `load1`, `load5`, `load15` | load average per core |
| `disk` | per mount point (`/` → `root`, `/var/data` → `var_data`) | usage in % |
| `oom` | `kills` | OOM kills since the last run |
| `journal` | `errors` | journal entries at or above priority `err` since the last run |
| `failed-units` | `failed` | number of failed systemd units |
| `systemd` | per unit (`a.service` → `a_service`) | state (`active` …) |
| `mount` | per path | read duration in ms, else `not mounted` / `no response` / `unreadable` |
| `sqlite-query` | — (value under `<instance>`) | a number from a SQL query, or its increase (`delta`) |
| `json-file` | `value`, `age` | a field of a JSON file; file age in seconds |

Sub-keys derived from paths or unit names must be unique (`/a_b` and `/a/b` both yield
`a_b` and are rejected by the configuration validator).

## memory

Source `/proc/meminfo`. RAM = `(MemTotal − MemAvailable) / MemTotal`, swap = `(SwapTotal
− SwapFree) / SwapTotal`. Without swap: value 0 with the note `no swap configured`
(measured, not guessed). Missing `MemAvailable` or a swap line: `unknown`.

Parameters (all optional): `ram_warn_percent` 90, `ram_crit_percent` 95,
`swap_warn_percent` 50, `swap_crit_percent` 80. The warn values match the former morning
routine's thresholds; the crit values are new.

## load

Source `/proc/loadavg`, divided by the core count (`os.availableParallelism()`).
Deliberately the load average instead of `/proc/stat` deltas: no state between runs.
The thresholds apply to `load5` and `load15`; `load1` is only stored for history,
because a one-minute spike is normal on small hardware.

Parameters: `warn_ratio` 1.5, `crit_ratio` 3.

## disk

Source `df -P -k -- <path>`, one entry per item in `mounts` (required, absolute paths in
normal form: no trailing slash, no `//`, `.` or `..`). Percentage as with `df`: `Used /
(Used + Available)`. Missing path, empty or unexpected output, timeout: `unknown`.

Parameters: `warn_percent` 85, `crit_percent` 95.

## boot

Reports the reboot of the whole machine exactly once. The watermark (`ctx.state`) is
the boot ID (`/proc/sys/kernel/random/boot_id`), which only changes on a reboot. Unlike
`uptime` with `warn_below_seconds`, the result does not depend on whether a run falls
into the first minutes after boot.

- First run without a stored ID: remember the ID, `ok` (0), reason `baseline`. No
  alert.
- ID unchanged: `ok` (0).
- ID changed: value 1, the new ID is stored (the event is reported only once). The
  reason names the boot time (from uptime, UTC) and the end of the previous run,
  determined from the previous run's journal (`journalctl _BOOT_ID=<old ID> -n 300`, as
  a match, not `-b`: a plain-digit ID would be read as an offset):
  - **clean:** a message from systemd (PID 1) that only appears on an orderly shutdown
    (`Shutting down.` or `Reached target reboot|poweroff|halt|kexec.target`). Status
    `severity` (default `warn`).
  - **unclean:** journal readable, but no such message — crash, power loss, reset.
    Status `unclean_severity` (default `crit`).
  - **unknown:** the previous run's journal is missing (not persistent), unreadable
    (group `systemd-journal`), `journalctl` fails or returns no JSON. The reboot is
    still reported, with `severity`; when in doubt, never `clean`. On hosts without a
    persistent journal this is the normal case.
- Boot ID unreadable: `unknown` with a reason, stored ID unchanged.

Parameters (optional): `severity`, `unclean_severity` (each `warn` or `crit`). Like the
other event counters, the collector needs `confirm_runs: 1` for `boot` (see
[collector.md](collector.md)). Limit: a reboot whose boot ID changes twice between two
runs shows up as one event; the end refers to the boot that was measured last.

**Announced reboot.** `bin/skopos.js expect-reboot [--reason <text>]` drops a marker
file before a deliberate reboot (e.g. ahead of a planned kernel update) (default
`/var/lib/skopos/expected-reboot.json` — the same on every host, see `bin/install.sh`,
no per-host configuration needed). If `boot` finds a fresh marker at the next reboot
and the end was `clean`, the finding becomes `ok` instead of `severity`, and the reason
names the `--reason`. An `unclean` end is unaffected — a crash is never "expected",
marker or not. The marker is single-use: read and deleted at exactly the reboot it
matches, or earlier, as soon as it is older than `expected_max_age_minutes` (default
30) — a marker from an aborted maintenance run can never attach itself to a later,
unrelated reboot this way. Parameters (optional): `expected_marker` (path, absolute),
`expected_max_age_minutes` (number > 0).

## oom

Source: the kernel journal (`journalctl -k -o json`). One line is counted per killed
process (`Out of memory: Killed process …`, including the cgroup variant), not the
accompanying lines. The journal cursor of the most recent entry is the watermark
(`ctx.state`); the first run without a cursor counts since the current boot (`-b`).

The cursor only advances after a normal run. If the journal is unreadable (group
`systemd-journal` missing, `journalctl` missing, timeout, no JSON output) or the first
run has no kernel message at all: `unknown`, cursor unchanged. If `journalctl` rejects
the stored cursor ("Failed to seek to cursor"), the check counts once since the current
boot, sets a new cursor and names the fallback in the reason — even on `ok`. Kills
since the boot that were already counted before can then reappear once; the reason
points this out.

Parameters: `severity` (`warn`/`crit`, default `crit`) on at least one kill.

## journal

Error lines in the systemd journal since the last run (`journalctl -o json`, priority
at or above `priority`). It takes over the semantics of the former morning routine's
log scan: priorities `err` through `emerg`, optionally restricted to units, exclusion
patterns against noise. It deliberately does not read plain text files (no second
watermark mechanism, as long as no host needs it).

The journal cursor of the most recent entry is the watermark (`ctx.state`); the first
run without a cursor looks back 24 hours. An empty journal is measured as `0`, not
`unknown` (unlike `oom`: a host without errors is the normal case). Everything is
counted; only the value and, in `reason`, up to three examples (160 characters each,
with unit) are stored.

Failure cases, each with a reason:
- **Journal unreadable** (group `systemd-journal` missing, `journalctl` missing,
  timeout, no JSON output): `unknown`, cursor unchanged.
- **Cursor invalid** (journal rotated or deleted, "Failed to seek to cursor"): once 24
  hours back, new cursor, the reason names the fallback — even on `ok`.
- **Very many hits:** the value counts all of them, `reason` stays short. A run's
  output is capped at 8 MB; if that is reached, the value is a lower bound, the cursor
  stays at the last complete entry, and the next run reads the rest.

Parameters (all optional): `units` (list of unit names; without it, the whole system),
`priority` (`emerg`, `alert`, `crit`, `err` — default —, `warning`), `exclude` (list of
regular expressions, case-insensitive, against the message text; excluded entries don't
count), `severity` (`warn` — default — or `crit` on at least one hit).

## failed-units

Counts units in state `failed` (`systemctl list-units --failed`), machine-wide. A
failed timer job shows up here; a plainly stopped unit does not — that is what
`systemd` with an explicit unit list is for. `systemctl` not runnable: `unknown`, never
`0`.

Parameters (optional): `ignore` (unit names known to be allowed to fail), `severity`
(`warn` — default — or `crit`). The `reason` names up to five units.

## systemd

Configured is the list `units`, each entry `unit` (required), `expected` (`active`,
default, or `inactive`) and `severity` (`warn` or `crit`, default `crit`). Source is
`systemctl show -p LoadState -p ActiveState` (plus `SubState`, `Result`,
`StateChangeTimestampMonotonic`); unlike `is-active` this distinguishes a missing unit
(`unknown`, `unit not found`) from a stopped one. Deviation from the target: `severity`.
Transitional states (`activating`, `deactivating`, `reloading`, `refreshing`) are
`warn`. Missing `systemctl` or unknown state: `unknown`.

**Grace period after boot.** Optional `boot_grace_seconds` (number ≥ 0, default 0 =
off), for the whole list. While the machine's uptime is below the value, `activating`
and `inactive` count as `ok` for units with `expected: active`; the value stays the
real state, the reason reads `within boot grace (<N> s since boot)`. This way a reboot
produces exactly one finding (check `boot`) instead of a warning per starting service.
Never tolerated: `failed`, and any state once the grace period has elapsed — a service
that still isn't running after ten minutes is a finding. The grace period should sit
just above the machine's normal boot duration. Other checks (`mount`, `journal` …) have
no grace period.

**Controlled restart.** Optional `restart_grace_seconds` (number ≥ 0, default 0 = off)
for the whole list or per unit (the unit's value wins). Only for units with `expected:
active`: if the unit is in a transitional state or `inactive`, `Result` is `success`,
`SubState` is not `auto-restart`, and the last state change
(`StateChangeTimestampMonotonic`, compared against the monotonic clock) happened at
most that many seconds ago, the result is `ok`. The value stays the real state, the
reason reads `controlled restart tolerated (<state>, <N> s)`. After the grace period
elapses, the evaluation above applies — a lasting `systemctl stop` is therefore a
finding once the grace period is over. Never tolerated: `failed`, `Result` other than
`success` (`exit-code`, `signal`, `core-dump`, `oom-kill`, `timeout`, `watchdog` …) and
`auto-restart`. If `Result` or the timestamp is missing, `0`, unreadable or in the
future, there is no tolerance, just the evaluation from above.

In practice the tolerance kicks in on a real restart (`systemctl restart`:
`deactivating`, then `activating`). After a `systemctl stop` without an immediate
following start, systemd usually evicts a unit nothing references anymore from memory;
the next query loads it fresh with `StateChangeTimestampMonotonic=0` and the default
`Result=success`. This case is not measurable and therefore gets the previous
evaluation — a stop with a pause before the start is a finding, even inside the grace
period.

Limits: Skopos detects states, not intent; a stop by a foreign tool with
`Result=success` is tolerated too. systemd resets `Result` on the next start: a service
that is `activating` again right after a crash, thanks to `Restart=`, looks like a
clean start inside the grace period. A single crash with a fast restart therefore
doesn't stand out here, but a crash loop usually does, because of the `auto-restart`
state; the error messages for that are captured by the `journal` check. The grace
period should sit just above the longest normal stop-plus-start duration, not beyond
it.

## mount

For each entry in `paths` (required, absolute paths in normal form as with `disk`;
`/mnt/x/` would never be recognized as a mount point and would produce a permanent
false alarm, so the config rejects it): first the path must appear in
`/proc/self/mountinfo` as a mount point (else `crit`, `not mounted`), then its
directory must be readable within `read_timeout_seconds` (default 5).

The read test runs in a **child process**, which gets `SIGKILL` on timeout or check
abort. A hanging network/FUSE mount blocks the syscall in the kernel; inside the
Skopos process itself that would permanently tie up a libuv thread. Result on a hang:
`crit`, `mount does not respond`. All paths are checked in parallel, so a hanging mount
doesn't hold up the others. The check's own time limit (`timeout_seconds`, default 30)
must be above `read_timeout_seconds`.

## Business checks: sqlite-query and json-file

Two generic checks for metrics that some other piece of software keeps locally. What
gets measured lives exclusively in the host's configuration (database, query, field,
thresholds), never in the code. Examples: `config/example.json`. Both are read-only
and make no network access.

### sqlite-query

Runs **one** SQL query against a foreign SQLite database and evaluates the single
number it returns. One entry, one value; several metrics are several entries. The
value is stored without a sub-key, under `<instance>`.

Parameters: `database` (required, absolute path), `query` (required), `column`,
`null_as`, `unit`, `delta`, `on_decrease` (required with `delta`) and the thresholds
`warn_above`, `crit_above`, `warn_below`, `crit_below` (`≥` resp. `≤`; if both are set,
the worse one wins).

**Read-only, secured twice over:**
1. The query must be exactly one `SELECT` or `WITH` statement. Further statements,
   even after a semicolon, are already rejected by the configuration (semicolons
   inside strings and comments are allowed). `prepare()` would silently ignore
   trailing statements, so Skopos checks the text itself.
2. The connection is read-only (decision 5, opening function `lib/sqlite-read.js`): if
   `<db>-wal` exists, a normal `readOnly` open, else `file:<path>?mode=ro&immutable=1`.
   A `WITH … DELETE` that passes the text check fails there; the file stays
   byte-identical. Foreign connections get a `busy_timeout` of 5 seconds.

`immutable=1` takes no locks. If the owner starts writing exactly while reading is
happening, the read could tear. Skopos therefore compares inode, size, modification
time and `-wal` existence before and after the read; on a change it reads once more,
after that the result is `unknown` (`database changed while it was being read`), never
a value from a file in motion.

**Result shape:** exactly one row with exactly one column (or the column `column`). No
row, several rows, several columns without `column`, text or a BLOB instead of a
number: `unknown` with a reason. `NULL` is `unknown`, **unless** the configuration
explicitly says `null_as: 0` (e.g. for a `SUM` over a day with no rows); the reason
names that. Missing file, missing read permission (`no read permission`), missing table
or column, not a valid database: `unknown` with a reason. The query runs synchronously
in the Skopos process and cannot be interrupted; it must be cheap (index, small table).

**`delta: true`** evaluates the increase of a counter since the last run instead of its
value. The watermark is the last value read (`ctx.state`). Run 1 has no baseline and is
`unknown` (`no baseline yet`), run 2 returns the increase. What a **falling** value
means depends on the counter, so `delta` requires `on_decrease`:

- `"restart"` — the counter genuinely starts over (e.g. a daily count): everything
  since the restart is counted, never a negative value; the reason names it. Increases
  between the last run before the restart and the restart are not visible.
- `"rebase"` — the value should really never fall (e.g. a sum over all rows). If it
  does, rows were deleted or restored from a backup. The new value becomes the
  baseline, the run is `unknown` once with a reason. With `"restart"` the whole
  remaining sum would be reported as a new increase here — a false `crit`.

Recommended is a sum over all rows with `"rebase"`: it does not fall back on its own,
and a day change hides nothing. If the database is unreadable in a run, the watermark
stays put; the next success counts from the last successful read.

### json-file

Reads a local JSON file (at most 1 MiB) and evaluates a field and the file age. Keys:
`value` (the field, only with `field`) and `age` (seconds since `mtime`).

Parameters: `file` (required, absolute path), `field` (dot path, e.g. `result.status`
or `items.0.count`; own properties only), `expected` (string, number or boolean;
deviation yields `severity`, default `crit`), alternatively the numeric thresholds as
with `sqlite-query`, `unit`, `warn_age_seconds`, `crit_age_seconds`.

Field values are strings, numbers or booleans (stored as text `true`/`false`);
`expected` compares strictly, without conversion (`5` is not `"5"`). Missing file,
missing read permission, invalid or half-written JSON, missing field, an
object/array/`null` as the field value, or text with numeric thresholds: `unknown`
with a reason, never a zero. If the file cannot be read, both keys are `unknown`; if
only the JSON is broken, the age is still measured. If `mtime` is more than a minute in
the future, the age is `unknown` (clock error), below that 0 applies.
