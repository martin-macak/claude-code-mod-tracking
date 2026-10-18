#!/usr/bin/env bash
# Use an isolated CLI config; install and update must fetch the actual archive.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=scripts/release/version.sh
source "$here/version.sh"

compare_install() {
  local config=$1 expected=$2 version=$3 installed
  installed=$(jq -er '.plugins["artifact-tracking@mod-tracking"][] | select(.scope == "user") | .installPath' \
    "$config/plugins/installed_plugins.json")
  [ "$(jq -r .version "$installed/.claude-plugin/plugin.json")" = "$version" ] || {
    echo "Installed manifest does not match $version." >&2; return 1;
  }
  jq -e --arg version "$version" \
    '.plugins["artifact-tracking@mod-tracking"] | any(.scope == "user" and .version == $version)' \
    "$config/plugins/installed_plugins.json" >/dev/null
  # Archive installs add a CLI-owned cache marker. Remove only that root marker
  # from a snapshot, leaving all plugin files and the live cache untouched.
  local snapshot result=0
  snapshot=$(mktemp -d)
  cp -R "$installed/." "$snapshot/"
  rm -rf "$snapshot/.in_use"
  diff -r "$expected" "$snapshot" || result=$?
  rm -rf "$snapshot"
  return "$result"
}

if [ "${1:-}" = compare ]; then compare_install "$2" "$3" "$4"; exit; fi
tag=${1:?Pass the published release tag}
version=$(tag_version "$tag")
repo=${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

download_release() {
  local release_tag=$1 dest=$2 release_version
  release_version=$(tag_version "$release_tag")
  mkdir -p "$dest/assets" "$dest/files"
  gh release download "$release_tag" --repo "$repo" --dir "$dest/assets" \
    --pattern "artifact-tracking-$release_version.zip" --pattern artifact-tracking.zip --pattern SHA256SUMS
  (cd "$dest/assets" && if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS
  else shasum -a 256 -c SHA256SUMS; fi)
  cmp "$dest/assets/artifact-tracking-$release_version.zip" "$dest/assets/artifact-tracking.zip"
  unzip -q "$dest/assets/artifact-tracking-$release_version.zip" -d "$dest/files"
  [ "$(jq -r .version "$dest/files/artifact-tracking/.claude-plugin/plugin.json")" = "$release_version" ]
}

archive_catalog() {
  local url=$1 destination=$2
  mkdir -p "$destination/.claude-plugin"
  jq --arg url "$url" \
    '(.plugins[] | select(.name == "artifact-tracking") | .source) = {source:"archive", url:$url}' \
    "$root/.claude-plugin/marketplace.json" > "$destination/.claude-plugin/marketplace.json"
}

latest=$(gh api "repos/$repo/releases/latest")
stable_tag=$(jq -r .tag_name <<< "$latest")
stable_version=$(tag_version "$stable_tag")
if [[ "${version%%+*}" == *-* ]]; then
  [ "$stable_tag" != "$tag" ]
  [ "$stable_tag" = "${LATEST_BEFORE:?CI must record latest before publishing an RC}" ]
else
  [ "$stable_tag" = "$tag" ]
fi
download_release "$tag" "$tmp/published"

# A pre-release still checks that the public stable marketplace resolves to stable.
if [ "$stable_tag" = "$tag" ]; then stable_files="$tmp/published/files/artifact-tracking"
else
  archive_catalog "https://github.com/$repo/releases/download/$tag/artifact-tracking.zip" "$tmp/rc-catalog"
  CLAUDE_CONFIG_DIR="$tmp/rc-config" claude plugin install artifact-tracking --marketplace "$tmp/rc-catalog"
  compare_install "$tmp/rc-config" "$tmp/published/files/artifact-tracking" "$version"
  if ! jq -e 'any(.assets[]; .name == "artifact-tracking.zip" and .state == "uploaded")' <<< "$latest" >/dev/null; then
    echo 'RC archive verified and latest unchanged. Stable marketplace smoke awaits its first alias asset.'
    exit 0
  fi
  download_release "$stable_tag" "$tmp/stable"
  stable_files="$tmp/stable/files/artifact-tracking"
fi

stable_url="https://github.com/$repo/releases/latest/download/artifact-tracking.zip"
archive_catalog "$stable_url" "$tmp/catalog"
if jq -e '.plugins[] | select(.name == "artifact-tracking") | .source.source == "archive"' \
  "$root/.claude-plugin/marketplace.json" >/dev/null 2>&1; then
  # After cutover, use the public marketplace so a bad catalog is detected too.
  CLAUDE_CONFIG_DIR="$tmp/fresh-config" claude plugin install artifact-tracking --marketplace "$repo"
else
  echo 'Bootstrap: testing the archive catalog. Public marketplace cutover is still pending.'
  CLAUDE_CONFIG_DIR="$tmp/fresh-config" claude plugin install artifact-tracking --marketplace "$tmp/catalog"
fi
compare_install "$tmp/fresh-config" "$stable_files" "$stable_version"

# Reproduce the old relative-path source with a real 0.1.0 installation, then
# change that same catalog to archive and exercise the normal update command.
mkdir -p "$tmp/legacy"
git archive artifact-tracking--v0.1.0 .claude-plugin plugins/artifact-tracking | tar -x -C "$tmp/legacy"
CLAUDE_CONFIG_DIR="$tmp/update-config" claude plugin install artifact-tracking --marketplace "$tmp/legacy"
compare_install "$tmp/update-config" "$tmp/legacy/plugins/artifact-tracking" 0.1.0
cp "$tmp/catalog/.claude-plugin/marketplace.json" "$tmp/legacy/.claude-plugin/marketplace.json"
CLAUDE_CONFIG_DIR="$tmp/update-config" claude plugin marketplace update mod-tracking
CLAUDE_CONFIG_DIR="$tmp/update-config" claude plugin update artifact-tracking@mod-tracking
compare_install "$tmp/update-config" "$stable_files" "$stable_version"
echo "Release smoke passed: $tag; stable marketplace $stable_tag."
