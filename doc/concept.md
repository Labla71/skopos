# Skopos — Concept

Skopos is a lean monitor: the same Node.js code runs on every machine, a local
configuration file decides what gets checked there. Measurements go into a local SQLite
database. An external evaluator (an agent or a script) pulls them over SSH and evaluates
them; the collector `skopos collect` ([collector.md](collector.md)) ships for exactly that.
This page holds the general "why"; the individual decisions are in
[decisions.md](decisions.md). Deutsch: [concept.de.md](concept.de.md).

## Motivation

A service hit an external provider's request limit every day for six days straight. It
kept getting rejected even though it was only pushing a fraction of its daily quota.
Nobody noticed, for two reasons:

- **Snapshots don't see daily patterns.** The existing morning routine measures once at
  night. A fault that comes and goes during the day is invisible in it.
- **The projection was missing where it was needed.** The existing quota evaluation only
  covered the main installation; on the other machines it returned "unknown" and that was
  read as "fine".

From this follows what Skopos has to deliver: **history instead of a snapshot**, and
**"unknown" must never look like "ok"**.

## Why not an existing tool

Established monitoring tools exist and were considered. Three reasons tipped the
decision toward a new, small tool instead:

- **Resource budget.** The machines to watch all run Node.js and range down to 2
  cores, 2 GB RAM and 15 GB disk. Every established solution that was evaluated
  needed more than that for a use case this narrow.
- **Fit with existing automation.** The result had to slot into scripted, ticket-driven
  operations already in place, through a stable, scriptable interface (JSON
  configuration in, JSON report out) rather than a UI — and it had to be easy for an
  LLM to configure from documentation alone, without a human reading a manual first.
- Also, honestly: curiosity — a chance to build this kind of tool from scratch.

## Principles

1. **Read only, never intervene.** No starting, stopping or fixing, no writing to
   someone else's files or databases; foreign SQLite databases are opened read-only
   only. A monitor that intervenes becomes a source of failure itself.
2. **Pull, not push.** Skopos sends nothing. The evaluator pulls. That way no
   installation needs an outgoing connection, and nothing leaves a machine on its own.
3. **"Unknown" is not "ok".** Not measurable means `unknown` with a reason, never 0 or a
   default value. This exact trap is what hid the motivating incident.
4. **Fail loudly.** Every run writes a heartbeat. Missing fresh data is a finding in
   itself.
5. **Generic core, differences only in configuration.** No host special case in the
   code; the same codebase on every machine means a bug is fixed once.
6. **Checks as small, tested modules.** This bounds the risk of "one bug, wrong data
   everywhere" (model: Nagios's plugin model). In addition, the evaluator occasionally
   re-measures a value itself, as a spot check against systematic measurement errors.
7. **Stay lean.** No dashboard, no alerting, no web server, bounded retention. Skopos
   must also run on small hardware (2 cores, 2 GB RAM, 15 GB disk).
8. **Compute first, read later.** Thresholds are evaluated deterministically inside
   Skopos. The evaluator reads the result and the history instead of carrying check
   logic in a prompt.

## First candidates for checks

- **System:** RAM, swap, CPU load, disk usage, OOM kills
- **Services:** systemd units against a configured target state (active/inactive)
- **Mounts:** reachability of configured mount points
- **Logs:** error patterns in configured log files or journal units since the last run
- **Business, generic:**
  - `sqlite-query`: open a foreign SQLite database read-only, run a configured SQL
    query and check the result against thresholds;
  - `json-file`: check a field and the file age of a JSON file against thresholds.

  The concrete queries (which database, which field) live in each host's
  configuration, never in the code.

## What Skopos is not

No dashboard, no alerting system, no configuration management, no agent that fixes
things. It measures and stores.
