# CLAUDE.md — Skopos

Skopos (Greek for "lookout") is a lean, generic monitor in Node.js. The same code runs on
every machine; a local configuration file decides what gets checked there (resources,
services, mounts, log files, business metrics). Measurements go into a local SQLite
database, and an external collector pulls them over SSH.

This file serves two readers: someone who wants Skopos running on their own host, and
someone who changes the code. Start with the section that fits the request.

## Setting up Skopos on a host

Follow these steps when the user asks to install, configure or try Skopos. The documents
named here are the source of truth; read them instead of guessing.

1. **Check the requirements.** Linux with systemd, Node.js ≥ 22.13 (`node --version`).
   Nothing else is needed: no packages, no `npm ci`.
2. **Ask what should be monitored**, then build the configuration from the recipes in
   [doc/examples.md](doc/examples.md) (RAM/CPU, disk, reboots, services, journal errors, OOM
   kills, mounts, a metric from a SQLite database or a JSON file). Start from the skeleton
   there and add one `checks` entry per goal. Parameters per check are in
   [doc/checks.md](doc/checks.md), the file schema in [doc/core.md](doc/core.md). The
   configuration is validated strictly: an unknown check or key aborts the run, so use only
   what the documents name.
3. **Try it without installing.** This changes nothing on the system:

   ```bash
   bin/skopos.js run --config <file> --db /tmp/skopos.db
   bin/skopos.js report --json --db /tmp/skopos.db
   ```

   Read the report with the user. A check with status `unknown` could not measure (missing
   file, permissions, timeout) and names the reason. Fix the cause; do not treat it as ok.
4. **Install.** The installer needs root and creates a system user, files under
   `/opt/skopos`, `/etc/skopos`, `/var/lib/skopos` and a systemd timer. Say what it will do
   and get the user's go-ahead before running it:

   ```bash
   sudo bin/install.sh --config <file>
   ```

   `bin/install.sh --destdir <dir> --config <file>` stages the same files without root, for
   a look before the real run. Details: [doc/installation.md](doc/installation.md).
5. **Verify** with the commands under "Checking" in
   [doc/installation.md](doc/installation.md): the timer is active, the journal shows one
   line per run, `report --json` returns a fresh heartbeat.
6. **Several hosts.** One host polls the others with `skopos collect` and passes confirmed
   state changes to a command the user chooses. Setup: "Setting up the collector" in
   [doc/installation.md](doc/installation.md), behaviour and configuration:
   [doc/collector.md](doc/collector.md), example:
   [config/example-collect.json](config/example-collect.json).

Update and uninstall are in [doc/installation.md](doc/installation.md) as well. On an
installed host the same documents are at `/opt/skopos/doc`.

Keep the user's real configuration outside the repository checkout, or in the git-ignored
`config/local.json`.

## Principles

These are the load-bearing assumptions of the project and hold for every change and every
configuration. Reasoning: [doc/concept.md](doc/concept.md), decisions:
[doc/decisions.md](doc/decisions.md).

- **Read only, never intervene.** Skopos measures. It does not start, stop or repair
  anything and writes to no foreign database or file. Open foreign SQLite databases read-only.
- **Pull, not push.** Skopos sends nothing out on its own.
- **"Unknown" is not "ok".** A check that cannot measure stores `unknown` with a reason,
  never a zero or a default value.
- **Fail loudly.** Every run writes a heartbeat. Missing fresh data is a finding in itself.
- **Generic core, differences only in configuration.** No special case for a particular host
  in the code.
- **Checks are small, tested modules.** Every piece of measuring logic has unit tests.
- **Stay lean.** No dashboard, no alerting of its own, no web server.
- **Spare resources.** Skopos has to run on small hardware (2 cores, 2 GB RAM); the
  database's retention is bounded.
- **Zero dependencies.** SQLite via the built-in `node:sqlite`, no `npm ci` on the target.

If a request conflicts with one of these (a dashboard, a restart on failure, sending data
somewhere), say so and suggest doing it outside Skopos, for example in the command the
collector calls.

## Changing the code

- Node ≥ 22.13, ES modules, `node --test` as the test runner (`npm test`).
- **Language:** code, identifiers, comments, tests, CLI parameters, config keys, check names,
  report fields, database columns, messages and file names are English. The documentation
  under `doc/` is bilingual like the READMEs: `<name>.md` English, `<name>.de.md` German,
  linked to each other, same structure ([doc/decisions.md](doc/decisions.md), no. 11 and 14).
- **Nothing private in the repository:** no real host names, IP addresses, user names, home
  paths, domains, e-mail addresses or keys — not in code, tests, fixtures or documentation.
  Use neutral names in examples (`example-host`, `example.org`). Real host configurations do
  not belong here; the repository holds only `config/example*.json`.
- Business checks are generic (`sqlite-query`, `json-file`). The concrete query lives in the
  configuration of the host, never in the code.
- `test/public.test.js` checks every file that would be published, including uncommitted
  ones, for private patterns. It runs with `npm test` and must not be bypassed. It reads
  additional private patterns from a file outside the repository (environment variable
  `SKOPOS_LEAK_PATTERNS`, otherwise the git-ignored file `.leak-patterns`).
- A new check needs a unit test, an entry in [doc/checks.md](doc/checks.md) and a recipe in
  both `doc/examples.md` and `doc/examples.de.md`. `test/doc.test.js` fails when the recipe
  is missing.
- Operator-specific rules go into the git-ignored `CLAUDE.local.md`, not into this file.

## Documentation — one place per question

| Question | Place |
|---|---|
| **Why** is it like this? | `doc/concept.md` (motivation, principles), `doc/decisions.md` (decisions) |
| **What** was changed? | Commit message, short |
| **How** does a check or the schema work? | `doc/checks.md`, `doc/core.md`, `doc/collector.md` |
| **How** do I configure a monitoring goal? | `doc/examples.md` |
| **How** do I install, update, uninstall? | `doc/installation.md` |
| **How** do I get started? | `README.md` (English), `README.de.md` (German) |
