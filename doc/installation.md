# Skopos — Installation, update, uninstall

How Skopos gets onto a target host and off again. The "why" is in [decisions.md](decisions.md)
(no. 7 system user and hardening, no. 8 distribution). Deutsch: [installation.de.md](installation.de.md).

## Requirements

- Linux with systemd and the group `systemd-journal`
- Node.js ≥ 22.13 (`node:sqlite` without a flag), no other packages, no `npm ci`
- root privileges for the installation

## Installation

The installer runs **locally on the target host**, from an unpacked source tree (Git
checkout, `git archive`, release archive):

```bash
sudo bin/install.sh --config <file>           # config from a file
sudo bin/install.sh --config - < <file>       # config over stdin
```

Further switches: `--version <id>` writes the id (e.g. a commit) to
`/opt/skopos/VERSION`, it shows up in the heartbeat; without the switch, the installer
takes a `VERSION` file from the source tree. `--node <path>` picks a specific Node
binary, otherwise the first one in `PATH`.

The installer checks **all preconditions first** and only changes anything afterwards:
root, systemd, the group `systemd-journal`, the Node version, and the configuration
with exactly the validator a run also uses. If a check fails, it aborts with a message
without creating anything.

Then it creates:

| What | Where | Owner, permissions |
|---|---|---|
| Code and docs (`bin`, `lib`, `systemd`, `doc`, `package.json`, `VERSION`) | `/opt/skopos` | `root`, `0755`/`0644` |
| Config | `/etc/skopos/config.json` | `root:skopos`, `0640` |
| Data (database `skopos.db`, `0644`) | `/var/lib/skopos` | `skopos:skopos`, `0755` |
| Units | `/etc/systemd/system/skopos.service`, `skopos.timer` | `root`, `0644` |
| System user | `skopos`, no login shell, supplementary group `systemd-journal` | — |

The code is staged next to `/opt/skopos` and then swapped in; an aborted copy leaves
the old state in place. Finally `systemctl enable --now skopos.timer`.

The timer follows `interval_minutes` from the config: if the value divides the hour
(5, 10, 15 …), `OnCalendar=*:0/<n>`, otherwise `OnBootSec`/`OnUnitActiveSec`.
`ExecStart` contains the absolute Node path that was checked during installation.

The unit runs as `skopos` with `ProtectSystem=strict`,
`ReadWritePaths=/var/lib/skopos`, `ProtectHome=read-only`, `PrivateTmp=yes`,
`NoNewPrivileges=yes` and `UMask=0022`: writing outside `/var/lib/skopos` fails at the
kernel (`EROFS`), not because of the code's discipline. Plus
`ProtectKernelTunables`, `ProtectControlGroups`, `RestrictSUIDSGID` and
`PrivateDevices`.

`PrivateNetwork=yes` takes away all networking from the run: "pull, not push" is thus
also enforced by the kernel. `systemctl` and `journalctl` keep working because they use
Unix sockets and files in the filesystem. `MemoryMax=200M` and `CPUQuota=50%` protect
the monitored host from a faulty check (a normal run needs around 55 MB). If the limit
is hit, the run ends; that shows up as a missing heartbeat and, in the next run, as an
OOM kill. `systemd-analyze security` rates the unit at 6.8 ("MEDIUM"), 8.4 without
these additions.

## Update

The same command. Without `--config` the installed configuration is kept:

```bash
sudo bin/install.sh --version <id>
sudo /opt/skopos/bin/install.sh              # from the installed state, e.g. after a Node switch
```

The database is always kept; the next run migrates an older schema version. The
installer is repeatable: running it twice in a row yields the same end state.

## Checking

```bash
systemctl is-active skopos.timer
systemctl list-timers skopos.timer
journalctl -u skopos.service -n 20
/opt/skopos/bin/skopos.js report --json       # as any user, without sudo
```

Every run writes one line to the journal, e.g.
`run 12: ok=25 warn=0 crit=0 unknown=0 (120 ms, peak rss 60.2 MB)` — the run's duration
and peak RSS. `systemctl show -p MemoryPeak` doesn't work for this: systemd doesn't
keep the value of a finished oneshot unit.

## Setting up the collector

Only on the one host that polls the others ([collector.md](collector.md)). Skopos is
installed there as above; the collector runs as a normal user with SSH access to the
hosts (in the example `monitor`), as a systemd user unit. Linger makes it run without a
login.

```bash
sudo install -d -o monitor -g skopos -m 2750 /var/lib/skopos-collect
sudo loginctl enable-linger monitor
# as monitor:
mkdir -p ~/.config/skopos ~/.config/systemd/user
cp /path/to/collect.json ~/.config/skopos/collect.json
cp /opt/skopos/systemd/user/skopos-collect.* ~/.config/systemd/user/
systemctl --user daemon-reload
/opt/skopos/bin/skopos.js collect --config ~/.config/skopos/collect.json
systemctl --user enable --now skopos-collect.timer
```

The state directory belongs to the collector user, has the group `skopos` and the
setgid bit: the state file (0640) inherits the group, and the measuring service can
check its age with a `json-file` check (`warn_age_seconds`/`crit_age_seconds`). An
update of Skopos updates the collector along with it; the units are copied again
afterwards if they changed.

## Uninstallation

Removes everything the installer created. The measurement data is lost in the process;
whoever wants to keep it backs up `/var/lib/skopos/skopos.db` first.

```bash
sudo systemctl disable --now skopos.timer
sudo systemctl stop skopos.service
sudo rm -f /etc/systemd/system/skopos.service /etc/systemd/system/skopos.timer
sudo systemctl daemon-reload
sudo rm -rf /opt/skopos /etc/skopos /var/lib/skopos
sudo userdel skopos
```

`userdel` also removes the group of the same name, provided it is empty. Skopos has
changed nothing outside these paths.

## Trial run without root

For testing, `--destdir <dir>` writes the same files below that directory, without a
user, without `chown` and without systemd (`test/install.test.js`):

```bash
bin/install.sh --destdir /tmp/skopos-stage --config config/example.json
```
