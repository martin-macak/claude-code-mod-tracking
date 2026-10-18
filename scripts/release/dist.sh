#!/usr/bin/env bash
# Keep tracked HEAD files and stamp only the manifest in a staging directory.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=scripts/release/version.sh
source "$here/version.sh"
version=${1:-}
valid_version "$version" || { echo "Invalid version: $version" >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
git archive --prefix=artifact-tracking/ HEAD:plugins/artifact-tracking | tar -x -C "$stage"
manifest="$stage/artifact-tracking/.claude-plugin/plugin.json"
jq --arg version "$version" '.version = $version' "$manifest" > "$stage/manifest.json"
mv "$stage/manifest.json" "$manifest"
mkdir -p "$root/dist"
rm -f "$root/dist/artifact-tracking-$version.zip" "$root/dist/artifact-tracking.zip"
(cd "$stage" && zip -qr "$root/dist/artifact-tracking-$version.zip" artifact-tracking)
cp "$root/dist/artifact-tracking-$version.zip" "$root/dist/artifact-tracking.zip"
(cd "$root/dist" && if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "artifact-tracking-$version.zip" artifact-tracking.zip
else
  shasum -a 256 "artifact-tracking-$version.zip" artifact-tracking.zip
fi > SHA256SUMS)
cat "$root/dist/SHA256SUMS"
