#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/expected/.claude-plugin" "$tmp/installed/.claude-plugin" "$tmp/config/plugins"
printf '{"version":"0.2.0-rc.1"}\n' > "$tmp/expected/.claude-plugin/plugin.json"
printf 'released\n' > "$tmp/expected/hooks.ts"
cp -R "$tmp/expected/." "$tmp/installed/"
jq -n --arg path "$tmp/installed" '{version:2, plugins:{"artifact-tracking@mod-tracking":[{scope:"user",version:"0.2.0-rc.1",installPath:$path}]}}' > "$tmp/config/plugins/installed_plugins.json"
bash "$here/smoke.sh" compare "$tmp/config" "$tmp/expected" 0.2.0-rc.1
mkdir "$tmp/installed/.in_use"
printf 'CLI cache marker\n' > "$tmp/installed/.in_use/1234"
bash "$here/smoke.sh" compare "$tmp/config" "$tmp/expected" 0.2.0-rc.1
printf 'unreleased\n' > "$tmp/installed/hooks.ts"
if bash "$here/smoke.sh" compare "$tmp/config" "$tmp/expected" 0.2.0-rc.1; then
  echo 'FAIL: smoke accepted different installed files'; exit 1
fi
cp "$tmp/expected/hooks.ts" "$tmp/installed/hooks.ts"
if bash "$here/smoke.sh" compare "$tmp/config" "$tmp/expected" 0.1.0; then
  echo 'FAIL: smoke accepted the wrong version'; exit 1
fi
printf 'extra\n' > "$tmp/installed/extra"
if bash "$here/smoke.sh" compare "$tmp/config" "$tmp/expected" 0.2.0-rc.1; then
  echo 'FAIL: smoke accepted an extra installed file'; exit 1
fi
printf 'Smoke comparison tests passed.\n'
