# Skopos — Decisions

Architecture decisions in decision-record style: context, decision, rationale,
consequences. The project's "why" is in [concept.md](concept.md).
Deutsch: [decisions.de.md](decisions.de.md).

Baseline for the measurements: Node 22.23, smallest target machine with 2 cores, 1.9 GB
RAM and 15 GB disk. Foreign databases are readable by everyone but writable only by
their owner.

## 1. Configuration as a JSON file

- **Context:** Every machine needs its own list of checks.
- **Decision:** JSON under `/etc/skopos/config.json`. Examples in the repo under
  `config/example*.json`; the installation copies the real file.
- **Rationale:** JSON is data, not code (an `.mjs` config could execute anything) and
  needs no dependency. The core validates strictly: an unknown check, an unknown key or
  a missing required value aborts loudly. Comments go through a `_comment` field.
- **Consequences:** No comment syntax, but nothing executable in the configuration.

## 2. Interval 5 minutes, retention 30 days

- **Context:** Daily patterns need history, the disk is small.
- **Decision:** A timer every 5 minutes (`OnCalendar=*:0/5`), cleanup once a day inside
  the run itself; both overridable in the configuration.
- **Rationale:** Roughly ~15 checks × ~3 values × 288 runs/day ≈ 13,000 rows/day, over
  30 days ≈ 400,000 rows ≈ 30–40 MB. Uncritical even on the smallest machine.
- **Consequences:** 5-minute resolution; Skopos does not see shorter events.

## 3. Generic schema: `runs`, `measurements`, `state`

- **Context:** Every new measurement must not trigger a schema migration.
- **Decision:** `runs` is the heartbeat (start, end, duration, count per status, Skopos
  version). `measurements` has the columns `run_id`, `time`, `check`, `key`, `value`,
  `unit`, `status`, `reason`. `state` (`check`, `key`, `value`) is a watermark for
  checks that count "since the last run" (OOM, logs, rejections).
- **Rationale:** A table per check would turn every new measurement into a migration.
- **Consequences:** Evaluations run over keys instead of columns.

## 4. `node:sqlite` instead of a library

- **Context:** Nothing should need to be built on small hardware.
- **Decision:** The built-in `node:sqlite`, zero dependencies. Skopos's own database
  runs in journal mode `DELETE` (not WAL) with file permissions `0644`.
- **Rationale:** No `npm ci` on the target, no native module. Installation is a plain
  file copy. With `DELETE`, another user can open the database read-only without write
  permission on the directory; with WAL the problem from decision 5 would appear.
- **Consequences:** The API is still "experimental" in Node 22 (a warning, disabled via
  `--disable-warning=ExperimentalWarning`). A thin, tested storage layer absorbs a later
  API change.

## 5. Reading foreign WAL databases without changing permissions

- **Context:** A check needs to read a foreign SQLite database in WAL mode that its
  owner only opens per write. Between writes there are no `-wal`/`-shm` files; a
  `readOnly` reader would then try to create `-shm` and fail on the directory.
- **Decision:** The solution lives entirely inside the check:
  - `-wal` exists → normal `readOnly` open (`-wal`/`-shm` are readable).
  - `-wal` is missing → `file:<path>?mode=ro&immutable=1`. Without a WAL file the
    entire state is in the main file, so the read is exact.
- **Rationale:** This way Skopos needs neither the owner's group nor `sudo -u`. Other
  software's permissions stay untouched (the "read only" principle).
- **Consequences:** Every DB-reading check uses this one opening function and is tested
  against both cases.

## 6. Read path: SSH and `skopos report --json`

- **Context:** The evaluator needs the data but should not need to know the schema.
- **Decision:** Pull over SSH and `skopos report --json [--since <ISO>]`, not directly
  from the database.
- **Rationale:** The schema stays internal and may change. The evaluator needs no
  SQLite. The report can already fold in staleness (heartbeat age) itself
  ("compute first, read later").
- **Consequences:** The report is the stable interface and gets versioned.

## 7. Dedicated system user and systemd hardening

- **Context:** "Read only" should not depend on the code's discipline.
- **Decision:** A system user `skopos` without a login shell, with the supplementary
  group `systemd-journal` (journal including kernel, for the OOM and log checks); no
  sudo. The unit sets `ProtectSystem=strict`, `ReadWritePaths=/var/lib/skopos`,
  `ProtectHome=read-only`, `NoNewPrivileges=yes`, `PrivateTmp=yes` and further
  protection switches. `PrivateNetwork=yes` blocks all networking, `MemoryMax=200M` and
  `CPUQuota=50%` cap resource use.
- **Rationale:** A check bug that tries to write fails at the kernel, not at code
  discipline. The same holds for "pull, not push": without networking no code can send
  anything. The cap protects the monitored services on small hardware from Skopos
  itself.
- **Consequences:** Checks that need more privileges are a deliberate extension with
  their own decision record.

## 8. Distribution: generic installer, local on the target host

- **Context:** Targets should have neither a Git checkout nor npm.
- **Decision:** The repo ships a generic installer that runs **locally on the target
  host**: `sudo bin/install.sh --config <file>`. How the code gets there (e.g. `git
  archive` plus `tar` over SSH) is decided by a private wrapper outside the repo. The
  commit id lands in `/opt/skopos/VERSION` and in the heartbeat.
- **Rationale:** This makes the installer usable by anyone who downloads the repo.
  "Pull, not push" is about **measurement data**; a code deploy from an admin machine
  does not violate it.
- **Consequences:** An update is the same command.

## 9. Rollout: start with the weakest hardware

- **Context:** A bug in Skopos must not affect a production machine.
- **Decision:** Start with the weakest test machine, then the rest, the most important
  one last. Which machine is which stage lives in the operations plan, not here.
- **Rationale:** If it runs on the smallest hardware, it runs everywhere; failures hit
  first the machine where they cost the least.
- **Consequences:** The resource limits from decision 2 count as an acceptance
  criterion.

## 10. Smaller assumptions

- CPU load via the load average.
- Assigning a finding to a topic area is the evaluator's job, not Skopos's.
- The evaluator re-measures one value per week by spot check (see principle 6 in
  [concept.md](concept.md)).

## 11. English code and English interface

- **Context:** The repo is meant to become public and usable by anyone who downloads
  it.
- **Decision:** Code, identifiers, comments, tests, CLI parameters (`--since`),
  configuration keys (`interval_minutes`, `key`), check names (`sqlite-query`), report
  fields (`stale`, `history`), database columns, messages and file names (`install.sh`)
  are English. Documentation under `doc/` is bilingual (decision 14), the READMEs are
  bilingual.
- **Rationale:** Whoever opens the repo reads code and interface first. German
  identifiers exclude most readers; an English interface with a German inside would
  look unfinished. This was changed before any code except the core existed.
- **Consequences:** The schema starts with English columns fresh at version 1; there
  was no installation yet that would need migrating.

## 12. Collector in the repo: state machine generic, notification swappable

- **Context:** Until now a private script polled once a day and evaluated. Reacting
  within minutes needs frequent polling and an evaluation that reports only confirmed
  state changes, otherwise every spike produces a notification. This logic
  (soft/hard, recovery, host dependency, flapping, throttling) is not tied to any
  particular operation.
- **Decision:** Polling, the state machine and the state store ship as `skopos collect`
  in the repo, English and tested like the core. Notification goes through a swappable
  notifier interface; the type `command` ships built in, handing every confirmed
  change as JSON on stdin to a configured command. What becomes of it (ticket, mail,
  chat) is up to the operator, outside the repo. Only one host is configured as the
  collector; it runs as a user unit of a normal user with SSH access.
- **Rationale:** Whoever downloads Skopos should also be able to evaluate it, without
  writing the hard half themselves. The same code runs on every host, differences only
  live in configuration (principle 5). "Pull, not push" still holds: the hosts send
  nothing, the collector pulls; the measuring service stays without networking
  (decision 7). Skopos still does not alert on its own: it detects the change, the
  notification is a foreign command.
- **Consequences:** The event format (`event_version`) is, alongside the report, a
  second stable interface. The collector's state file is at the same time its
  heartbeat and is watched on the collector host with a `json-file` check. Details:
  [collector.md](collector.md).

## 13. Expected reboot: a marker file instead of a per-host special case

- **Context:** `boot` reports every reboot as `warn`, regardless of whether it was a
  crash or a deliberate maintenance action (e.g. a kernel update followed by a
  reboot). Without a distinction, every planned maintenance produces the same finding
  as a real incident — long term either a lot of noise or the temptation to silence
  the check per host and thereby miss real crashes too.
- **Decision:** `bin/skopos.js expect-reboot [--reason <text>]` writes a small marker
  file before a deliberate reboot (default `/var/lib/skopos/expected-reboot.json`, the
  same path on every host). The `boot` check reads it on the next reboot: if the end
  was `clean` and the marker was fresh, the finding becomes `ok` instead of
  `severity`. The marker is single-use (read and deleted on exactly the reboot it
  matches) and expires on its own after `expected_max_age_minutes` (default 30) — a
  marker from an aborted maintenance run can never stick around to attach itself to a
  later, unrelated reboot. An `unclean` end is unaffected by the marker.
- **Rationale:** No per-host special case in the code (principle 5) — the same
  mechanism kicks in automatically on every host that installs Skopos, without an
  entry in its local configuration. A file rather than state in the Skopos database,
  because it is written by an arbitrary caller (root, a maintenance script, someone by
  hand over SSH) without needing to know the name of the locally configured `boot`
  check. The expiry instead of a one-time delete on write prevents a leftover marker
  from wrongly attributing a later, unrelated reboot to "planned".
- **Consequences:** `expected_marker` and `expected_max_age_minutes` are new optional
  parameters of `boot` (see [checks.md](checks.md)); existing configurations without
  these parameters behave unchanged. Whoever does not call the command before a reboot
  still sees the previous `warn`/`crit` — the marker is an addition, not a
  requirement.

## 14. Bilingual documentation under `doc/`

- **Context:** The repo is meant to become public on GitHub; until now `doc/` was
  German-only prose with German file names (`konzept.md`, `entscheidungen.md`, …),
  while decision 11 already made code and interface English so the project is usable
  by anyone who downloads it.
- **Decision:** Every document under `doc/` exists twice: `<name>.md` in English
  (default, no suffix) and `<name>.de.md` in German, each linking to the other near
  the top. File names themselves are English (`concept.md`, `decisions.md`, `core.md`,
  `checks.md`, `installation.md`, `collector.md`, `examples.md`), matching the
  existing `README.md`/`README.de.md` convention and the GitHub-recommended pattern
  for localized files, rather than a `doc/en/`, `doc/de/` directory split.
- **Rationale:** A GitHub visitor reads code and top-level docs before anything else;
  an English default lowers the bar to actually use what is published, while the
  suffix convention needed no new tooling and stayed consistent with what the READMEs
  already did. A directory split would have meant per-language index files and more
  moving parts for seven documents that don't need a documentation-site generator.
- **Consequences:** Every future change to a document's content is made twice (once
  per language) or is flagged for translation; `bin/install.sh` ships the whole `doc/`
  directory to `/opt/skopos/doc`, so both languages are available on the installed
  host itself, without a repo checkout.
