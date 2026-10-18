#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

expect() {
  local status=$1 message=$2
  shift 2
  local actual=0 out
  out=$("$@" 2>&1) || actual=$?
  if [ "$actual" -ne "$status" ] || [[ "$out" != *"$message"* ]]; then
    printf 'FAIL: %s (wanted exit %s and %s, got %s)\n%s\n' "$*" "$status" "$message" "$actual" "$out"
    exit 1
  fi
  printf 'ok: %s\n' "$message"
}

# The parser must reject malformed SemVer before a build can start.
expect 0 '0.2.0-rc.1' bash "$here/version.sh" tag artifact-tracking--v0.2.0-rc.1
for tag in artifact-tracking--v1.2 artifact-tracking--v01.2.3 artifact-tracking--v1.2.3-01 artifact-tracking--v1.2.3-rc..1 artifact-tracking--v1.2.3+ other--v1.2.3; do
  expect 1 'Invalid release tag' bash "$here/version.sh" tag "$tag"
done
for pair in '0.2.0-rc.1 0.1.0' '0.2.0 0.2.0-rc.9' '1.0.0-rc.10 1.0.0-rc.9' '1.0.0-beta 1.0.0-9' '10.0.0 9.9.9'; do
  read -r new old <<< "$pair"
  expect 0 'newer' bash "$here/version.sh" newer "$new" "$old"
done
for pair in '0.2.0-rc.1 0.2.0' '1.0.0+build.2 1.0.0+build.1' '1.0.0-rc.1 1.0.0-rc.1.1' '0.1.0 0.2.0'; do
  read -r new old <<< "$pair"
  expect 1 'not newer' bash "$here/version.sh" newer "$new" "$old"
done

# Use real Git repositories: wrong branch, dirty, behind/ahead, off-main tags.
git init -q --bare "$tmp/origin.git"
git init -q -b main "$tmp/repo"
cd "$tmp/repo"
git config user.name 'Release test'
git config user.email 'release@example.invalid'
git remote add origin "$tmp/origin.git"
mkdir -p plugins/artifact-tracking/.claude-plugin .claude-plugin
printf '{"name":"artifact-tracking","version":"0.1.0"}\n' > plugins/artifact-tracking/.claude-plugin/plugin.json
printf 'released\n' > plugins/artifact-tracking/README.md
printf '{"name":"mod-tracking","plugins":[{"name":"artifact-tracking","source":"./plugins/artifact-tracking"}]}\n' > .claude-plugin/marketplace.json
git add .
git commit -qm 'Initial fixture'
git tag artifact-tracking--v0.1.0
git push -q origin main --tags
expect 0 '0.2.0-rc.1' bash "$here/ci.sh" check-tag artifact-tracking--v0.2.0-rc.1
expect 1 'Invalid release tag' bash "$here/ci.sh" check-tag artifact-tracking--v1.2
git switch -qc feature
printf 'feature\n' > feature
git add feature
git commit -qm 'Feature fixture'
expect 1 'not on main' bash "$here/ci.sh" check-tag artifact-tracking--v0.2.0
expect 1 'main only' bash "$here/release.sh" 0.2.0 --dry-run
git switch -q main
printf 'dirty\n' > untracked
expect 1 'working tree' bash "$here/release.sh" 0.2.0 --dry-run
rm untracked
expect 1 'Invalid version' bash "$here/release.sh" 1.2 --dry-run
expect 1 'VERSION is required' bash "$here/release.sh" '' --dry-run
expect 2 'VERSION is required' env -u VERSION make -f "$root/Makefile" release-dry
expect 1 'not newer' bash "$here/release.sh" 0.1.0 --dry-run
git tag artifact-tracking--v0.3.0-rc.1
expect 1 'not newer' bash "$here/release.sh" 0.2.0 --dry-run
git tag -d artifact-tracking--v0.3.0-rc.1 >/dev/null
git update-ref refs/remotes/origin/main HEAD~0
printf 'ahead\n' > ahead
git add ahead
git commit -qm 'Ahead fixture'
expect 1 'not origin/main' bash "$here/release.sh" 0.2.0 --dry-run
git reset -q --hard origin/main

# Only the remote API and test runner are doubled. Tag creation/push are real.
mkdir "$tmp/bin"
export GH_CALLS="$tmp/gh-calls" MAKE_CALLS="$tmp/make-calls"
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALLS"
if [ "${GH_FAIL:-0}" = 1 ]; then echo 'API unavailable' >&2; exit 1; fi
case "$*" in
  *'--method PATCH'*) exit 0 ;;
  *'releases/latest'*) cat "$RELEASE_JSON" ;;
  *'release create'*) exit 0 ;;
  *) printf '[{"number":7,"title":"artifact-tracking 0.2.0","open_issues":%s},{"number":8,"title":"artifact-tracking 0.2.0+build-1","open_issues":%s}]\n' "${OPEN_ISSUES:-0}" "${OPEN_ISSUES:-0}" ;;
esac
EOF
cat > "$tmp/bin/make" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MAKE_CALLS"
EOF
chmod +x "$tmp/bin/gh" "$tmp/bin/make"
export PATH="$tmp/bin:$PATH"
export OPEN_ISSUES=2
expect 1 'open issues' bash "$here/release.sh" 0.2.0 --dry-run
expect 1 'open issues' bash "$here/release.sh" 0.2.0+build-1 --dry-run
export GH_FAIL=1
expect 1 'API unavailable' bash "$here/release.sh" 0.2.0 --dry-run
unset GH_FAIL
expect 0 'artifact-tracking--v0.2.0-rc.1' bash "$here/release.sh" 0.2.0-rc.1 --dry-run
# A machine without gh deliberately skips the stable milestone guard.
mkdir "$tmp/no-gh"
for tool in bash dirname git; do ln -s "$(command -v "$tool")" "$tmp/no-gh/$tool"; done
expect 0 'skipping the milestone guard' env PATH="$tmp/no-gh" "$tmp/no-gh/bash" "$here/release.sh" 0.2.0 --dry-run
export OPEN_ISSUES=0
expect 0 'artifact-tracking--v0.2.0' bash "$here/release.sh" 0.2.0 --dry-run
[ ! -e "$MAKE_CALLS" ]
expect 0 'artifact-tracking--v0.2.0' bash "$here/release.sh" 0.2.0
git --git-dir="$tmp/origin.git" rev-parse refs/tags/artifact-tracking--v0.2.0 >/dev/null
[ "$(git cat-file -t artifact-tracking--v0.2.0)" = tag ]
grep -q '^test$' "$MAKE_CALLS"
bash "$here/ci.sh" close-milestone 0.2.0
grep -q 'milestones/7 --method PATCH -f state=closed' "$GH_CALLS"
: > "$GH_CALLS"
bash "$here/ci.sh" close-milestone 0.2.1-rc.1
[ ! -s "$GH_CALLS" ]
bash "$here/ci.sh" stamp artifact-tracking--v0.2.0-rc.1
[ "$(jq -r .version plugins/artifact-tracking/.claude-plugin/plugin.json)" = 0.2.0-rc.1 ]
git restore plugins/artifact-tracking/.claude-plugin/plugin.json

# The archive uses tracked HEAD files, but the tag version wins over the manifest.
printf 'local edit\n' > plugins/artifact-tracking/README.md
printf 'not released\n' > plugins/artifact-tracking/untracked
bash "$here/dist.sh" 0.2.0-rc.1
unzip -q dist/artifact-tracking-0.2.0-rc.1.zip -d "$tmp/unpacked"
[ "$(jq -r .version "$tmp/unpacked/artifact-tracking/.claude-plugin/plugin.json")" = 0.2.0-rc.1 ]
[ "$(cat "$tmp/unpacked/artifact-tracking/README.md")" = released ]
[ ! -e "$tmp/unpacked/artifact-tracking/untracked" ]
cmp dist/artifact-tracking.zip dist/artifact-tracking-0.2.0-rc.1.zip
(cd dist && shasum -a 256 -c SHA256SUMS)
[ "$(jq -r .version plugins/artifact-tracking/.claude-plugin/plugin.json)" = 0.1.0 ]

# Publishing an RC explicitly leaves latest alone; stable explicitly becomes latest.
export RUNNER_TEMP="$tmp" REPO='owner/repo' CLAUDE_CODE_VERSION=2.1.296
bash "$here/ci.sh" publish artifact-tracking--v0.2.0-rc.1
grep -q -- '--prerelease --latest=false' "$GH_CALLS"
bash "$here/ci.sh" publish artifact-tracking--v0.2.0
grep -Eq -- '--latest($| )' "$GH_CALLS"
: > "$GH_CALLS"
bash "$here/ci.sh" publish artifact-tracking--v0.2.0+build-1
grep -Eq -- '--latest($| )' "$GH_CALLS"
if grep -q -- '--prerelease' "$GH_CALLS"; then echo 'Stable build metadata was treated as prerelease'; exit 1; fi

# Cutover refuses a missing alias; it never leaves a broken marketplace entry.
export RELEASE_JSON="$tmp/release.json"
printf '{"tag_name":"artifact-tracking--v0.2.0","prerelease":false,"assets":[]}\n' > "$RELEASE_JSON"
expect 1 'artifact-tracking.zip' bash "$here/ci.sh" activate-marketplace
[ "$(jq -r '.plugins[0].source' .claude-plugin/marketplace.json)" = './plugins/artifact-tracking' ]
printf '{"tag_name":"artifact-tracking--v0.2.0","prerelease":false,"assets":[{"name":"artifact-tracking.zip","state":"uploaded"}]}\n' > "$RELEASE_JSON"
bash "$here/ci.sh" activate-marketplace
[ "$(jq -r '.plugins[0].source.url' .claude-plugin/marketplace.json)" = 'https://github.com/owner/repo/releases/latest/download/artifact-tracking.zip' ]
printf 'All release tests passed.\n'
