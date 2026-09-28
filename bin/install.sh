#!/usr/bin/env bash
# Skopos installer. Runs locally on the target host, as root:
#
#   sudo bin/install.sh --config <file|->  [--version <id>] [--node <path>]
#   sudo bin/install.sh                    (update: keeps /etc/skopos/config.json)
#        bin/install.sh --destdir <dir> ... (staging: files only, no user, no systemd)
#
# Copies the code from this source tree to /opt/skopos, the configuration to
# /etc/skopos/config.json, creates the system user `skopos`, the data directory
# /var/lib/skopos and the systemd units, and enables the timer. Repeatable: a second run
# leaves the same state, keeps the database and, without --config, the configuration.
# Every precondition (root, node >= 22.13, valid configuration, systemd) is checked before
# anything is changed.
set -euo pipefail

MIN_NODE="22.13"
USER_NAME="skopos"
JOURNAL_GROUP="systemd-journal"

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config=""
version_id=""
node=""
destdir=""

die() { echo "install.sh: $*" >&2; exit 1; }
usage() { sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --config)  [ $# -ge 2 ] || usage; config="$2"; shift 2 ;;
    --version) [ $# -ge 2 ] || usage; version_id="$2"; shift 2 ;;
    --node)    [ $# -ge 2 ] || usage; node="$2"; shift 2 ;;
    --destdir) [ $# -ge 2 ] || usage; destdir="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage ;;
  esac
done

if [ -n "$destdir" ]; then
  mkdir -p "$destdir"
  destdir="$(cd "$destdir" && pwd)"
fi
opt="$destdir/opt/skopos"
etc="$destdir/etc/skopos"
var="$destdir/var/lib/skopos"
units="$destdir/etc/systemd/system"

# --- Preconditions: nothing is changed until all of them hold. ---------------------------

if [ -z "$destdir" ]; then
  [ "$(id -u)" -eq 0 ] || die "must run as root (sudo), or with --destdir for staging"
  command -v systemctl >/dev/null || die "systemctl not found; Skopos needs systemd"
  getent group "$JOURNAL_GROUP" >/dev/null || die "group $JOURNAL_GROUP does not exist"
fi

[ -f "$src/bin/skopos.js" ] && [ -d "$src/lib" ] || die "source tree incomplete: $src"

if [ -z "$node" ]; then
  node="$(command -v node || true)"
  [ -n "$node" ] || die "node not found in PATH; Skopos needs Node.js >= $MIN_NODE"
fi
[ -x "$node" ] || die "node is not executable: $node"
node="$(readlink -f "$node")"
node_version="$("$node" -p 'process.versions.node' 2>/dev/null)" || die "cannot run $node"
[[ "$node_version" =~ ^([0-9]+)\.([0-9]+)\. ]] || die "cannot parse node version: $node_version"
min_major="${MIN_NODE%%.*}"; min_minor="${MIN_NODE#*.}"
major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
if [ "$major" -lt "$min_major" ] || { [ "$major" -eq "$min_major" ] && [ "$minor" -lt "$min_minor" ]; }; then
  die "node $node_version at $node is too old; Skopos needs >= $MIN_NODE"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ "$config" = "-" ]; then
  cat > "$work/config.json"
  config="$work/config.json"
elif [ -z "$config" ]; then
  [ -f "$etc/config.json" ] || die "no --config given and no existing $etc/config.json"
  config="$etc/config.json"
fi
[ -f "$config" ] || die "configuration not found: $config"

# Validate with the core's own loader (same rules as a run) and read the interval.
interval="$("$node" --disable-warning=ExperimentalWarning --input-type=module -e '
  const { loadConfig } = await import(process.argv[1]);
  try { process.stdout.write(String(loadConfig(process.argv[2]).interval_minutes)); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
' "$src/lib/config.js" "$config")" || die "configuration rejected: $config"

# Timer: a calendar spec when the interval divides an hour, otherwise a monotonic period.
if [ "$interval" -lt 60 ] && [ $((60 % interval)) -eq 0 ]; then
  schedule="OnCalendar=*:0/$interval"
else
  schedule="OnBootSec=${interval}min
OnUnitActiveSec=${interval}min"
fi

if [ -z "$version_id" ] && [ -f "$src/VERSION" ]; then
  version_id="$(tr -d '[:space:]' < "$src/VERSION")"
fi
if [ -n "$version_id" ] && ! [[ "$version_id" =~ ^[A-Za-z0-9._+-]+$ ]]; then
  die "invalid --version: $version_id"
fi

# --- Install. -------------------------------------------------------------------------------

if [ -z "$destdir" ]; then
  if ! getent passwd "$USER_NAME" >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir /var/lib/skopos \
      --shell /usr/sbin/nologin "$USER_NAME"
  fi
  usermod --append --groups "$JOURNAL_GROUP" "$USER_NAME"
fi

# Code: staged next to the target, then swapped in, so a failed copy leaves the old code.
mkdir -p "$(dirname "$opt")"
stage="$(mktemp -d "$(dirname "$opt")/.skopos.XXXXXX")"
cp -R "$src/bin" "$src/lib" "$src/systemd" "$src/doc" "$src/package.json" "$stage/"
[ -z "$version_id" ] || printf '%s\n' "$version_id" > "$stage/VERSION"
chmod -R u=rwX,go=rX "$stage"
chmod 0755 "$stage/bin/skopos.js" "$stage/bin/install.sh"
[ -n "$destdir" ] || chown -R root:root "$stage"
if [ -e "$opt" ]; then
  rm -rf "$opt.old"
  mv "$opt" "$opt.old"
fi
mv "$stage" "$opt"
rm -rf "$opt.old"

# Configuration: readable by the service user, not by everyone.
mkdir -p "$etc"
chmod 0755 "$etc"
if [ "$config" != "$etc/config.json" ]; then
  install -m 0640 "$config" "$etc/config.json.new"
  mv "$etc/config.json.new" "$etc/config.json"
fi
chmod 0640 "$etc/config.json"
[ -n "$destdir" ] || chown root:"$USER_NAME" "$etc/config.json"

# Data: owned by the service user; the database (0644) stays readable for the collector.
mkdir -p "$var"
chmod 0755 "$var"
[ -n "$destdir" ] || chown "$USER_NAME":"$USER_NAME" "$var"

mkdir -p "$units"
sed -e '/^# Template:/d' -e "s|@NODE@|$node|g" "$src/systemd/skopos.service" > "$work/skopos.service"
awk -v s="$schedule" '/^# Template:/ { next } { if ($0 == "@SCHEDULE@") print s; else print }' \
  "$src/systemd/skopos.timer" > "$work/skopos.timer"
install -m 0644 "$work/skopos.service" "$units/skopos.service"
install -m 0644 "$work/skopos.timer" "$units/skopos.timer"

if [ -z "$destdir" ]; then
  systemctl daemon-reload
  systemctl enable --now skopos.timer
  echo "Skopos ${version_id:-(no version)} installed; timer: $(systemctl is-active skopos.timer)."
else
  echo "Skopos ${version_id:-(no version)} staged in $destdir."
fi
