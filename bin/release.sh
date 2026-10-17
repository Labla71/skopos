#!/usr/bin/env bash
# Skopos release script. Builds the release archive from the tracked files of HEAD, tags
# the commit, pushes branch and tag, and creates the GitHub release with the archive.
#
#   bin/release.sh [--dry-run] [--notes <file>]
#
# The version comes from package.json; the tag is v<version>. Preconditions (checked before
# anything is changed): clean working tree, a branch that tracks origin, tag does not exist yet, tests pass.
# --dry-run builds and verifies the archive in a temporary directory and stops there.
# Authentication: set GH_TOKEN to the token of the publishing account (gh must be installed).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

dry=0
notes=""

die() { echo "release.sh: $*" >&2; exit 1; }
usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --notes)   [ $# -ge 2 ] || usage; notes="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "release.sh: unknown argument: $1" >&2; usage ;;
  esac
done

version="$(node -p "require('./package.json').version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "package.json version is not x.y.z: $version"
tag="v$version"
asset="$tag.tar.gz"

[ -z "$(git status --porcelain)" ] || die "working tree is not clean"
branch="$(git rev-parse --abbrev-ref HEAD)"
git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null || die "branch $branch does not track origin"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then die "tag $tag already exists"; fi

npm test >/dev/null 2>&1 || die "tests fail (run npm test)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar.gz --prefix="skopos-$version/" -o "$tmp/$asset" HEAD

# The archive must be readable and contain the package.json of exactly this version.
tar -xzOf "$tmp/$asset" "skopos-$version/package.json" | grep -q "\"version\": \"$version\"" \
  || die "archive does not contain package.json $version"

if [ "$dry" = 1 ]; then
  echo "dry run ok: $asset ($(wc -c < "$tmp/$asset") bytes)"
  exit 0
fi

command -v gh >/dev/null || die "gh not found"
[ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is not set (token of the publishing account)"
remote="$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
[ -n "$remote" ] || die "cannot derive owner/name from remote origin"

git tag -a "$tag" -m "Skopos $version"
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin "$branch" "$tag"

args=(release create "$tag" "$tmp/$asset" --repo "$remote" --title "Skopos $version")
if [ -n "$notes" ]; then args+=(--notes-file "$notes"); else args+=(--generate-notes); fi
gh "${args[@]}"

echo "released $tag: https://github.com/$remote/releases/tag/$tag"
