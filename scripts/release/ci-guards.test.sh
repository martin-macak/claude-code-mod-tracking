#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
group=${1:-all}

reject() {
  local label=$1 message=$2 status=0 out
  shift 2
  out=$("$@" 2>&1) || status=$?
  if [ "$status" = 0 ] || [[ "$out" != *"$message"* ]]; then
    printf 'FAIL %s: expected rejection containing %s; got exit %s\n%s\n' "$label" "$message" "$status" "$out"
    exit 1
  fi
  printf 'ok: %s\n' "$label"
}

no_release_writes() {
  if grep -Eq 'release create|--method PATCH' "$GH_CALLS"; then
    echo 'FAIL: rejected operation wrote to a release or milestone'
    cat "$GH_CALLS"
    exit 1
  fi
}

record_then_publish() {
  bash "$here/ci.sh" record-latest && bash "$here/ci.sh" publish artifact-tracking--v2.0.0
}

git init -q -b main "$tmp/repo"
cd "$tmp/repo"
git config user.name 'CI guard test'
git config user.email ci@example.invalid
printf 'fixture\n' > file
git add file
git commit -qm 'Initial fixture'
git update-ref refs/remotes/origin/main HEAD
git tag artifact-tracking--v1.0.0
git tag artifact-tracking--v2.0.0
git init -q --bare "$tmp/origin.git"
git remote add origin "$tmp/origin.git"
git push -q origin main --tags
mkdir "$tmp/bin"
export GH_CALLS="$tmp/calls" RUNNER_TEMP="$tmp" REPO=owner/repo CLAUDE_CODE_VERSION=2.1.296
: > "$GH_CALLS"
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$GH_CALLS"
case "$*" in
  api*)
    if [ "${GH_API_FAIL:-0}" = 1 ]; then echo 'API offline' >&2; exit 7; fi
    case "$*" in
      *'--method PATCH'*) exit 0 ;;
      *releases/latest*) printf '%s\n' "${LATEST_TAG-artifact-tracking--v1.0.0}" ;;
      *milestones*) printf '[{"number":7,"title":"artifact-tracking 2.0.0","open_issues":%s}]\n' "${OPEN_ISSUES:-0}" ;;
      *) echo 'Unexpected API call' >&2; exit 1 ;;
    esac ;;
  'release create'*) exit 0 ;;
  *) echo 'Unexpected gh call' >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

if [ "$group" = all ] || [ "$group" = version ]; then
  # The event tag already exists. It must not compare against itself.
  [ "$(bash "$here/ci.sh" check-tag artifact-tracking--v2.0.0)" = 2.0.0 ]
  reject 'older CI tag' 'not newer' bash "$here/ci.sh" check-tag artifact-tracking--v1.0.0
  git tag artifact-tracking--v1.5.0
  reject 'manually pushed lower tag' 'not newer' bash "$here/ci.sh" check-tag artifact-tracking--v1.5.0
  git tag artifact-tracking--v2.0.0+other
  reject 'equal precedence with build metadata' 'not newer' bash "$here/ci.sh" check-tag artifact-tracking--v2.0.0+other
  git tag -d artifact-tracking--v2.0.0+other >/dev/null
  # A newer remote tag can arrive after checkout and the early workflow check.
  git --git-dir="$tmp/origin.git" update-ref refs/tags/artifact-tracking--v2.1.0 "$(git rev-parse HEAD)"
  reject 'publication rechecks version order' 'not newer' bash "$here/ci.sh" publish artifact-tracking--v2.0.0
  no_release_writes
  git --git-dir="$tmp/origin.git" update-ref -d refs/tags/artifact-tracking--v2.1.0
  git tag -d artifact-tracking--v2.1.0 >/dev/null
fi

if [ "$group" = all ] || [ "$group" = milestone ]; then
  : > "$GH_CALLS"
  export OPEN_ISSUES=2
  reject 'stable publication with open issues' 'open issues' bash "$here/ci.sh" publish artifact-tracking--v2.0.0
  no_release_writes
  reject 'milestone closure with newly open issues' 'open issues' bash "$here/ci.sh" close-milestone 2.0.0
  no_release_writes
  export GH_API_FAIL=1
  reject 'stable publication on API failure' 'API offline' bash "$here/ci.sh" publish artifact-tracking--v2.0.0
  no_release_writes
  unset GH_API_FAIL
  export OPEN_ISSUES=0
  bash "$here/ci.sh" publish artifact-tracking--v2.0.0
  grep -q 'release create artifact-tracking--v2.0.0' "$GH_CALLS"
  bash "$here/ci.sh" close-milestone 2.0.0
  grep -q 'milestones/7 --method PATCH -f state=closed' "$GH_CALLS"
  : > "$GH_CALLS"
  export OPEN_ISSUES=2 GH_API_FAIL=1
  git tag artifact-tracking--v2.1.0-rc.1
  bash "$here/ci.sh" publish artifact-tracking--v2.1.0-rc.1
  bash "$here/ci.sh" close-milestone 2.1.0-rc.1
  grep -q -- '--prerelease --latest=false' "$GH_CALLS"
  if grep -q '^api ' "$GH_CALLS"; then echo 'FAIL: prerelease used milestone API'; exit 1; fi
  unset GH_API_FAIL
fi

if [ "$group" = all ] || [ "$group" = baseline ]; then
  if git rev-parse --verify refs/tags/artifact-tracking--v2.1.0-rc.1 >/dev/null 2>&1; then
    git tag -d artifact-tracking--v2.1.0-rc.1 >/dev/null
  fi
  : > "$GH_CALLS"
  export GITHUB_OUTPUT="$tmp/output"
  bash "$here/ci.sh" record-latest
  [ "$(cat "$GITHUB_OUTPUT")" = 'tag=artifact-tracking--v1.0.0' ]
  : > "$GITHUB_OUTPUT"
  : > "$GH_CALLS"
  export GH_API_FAIL=1
  reject 'latest API failure stops the publication sequence' 'API offline' record_then_publish
  [ ! -s "$GITHUB_OUTPUT" ]
  [ "$(wc -l < "$GH_CALLS")" -eq 1 ]
  no_release_writes
  unset GH_API_FAIL
  export LATEST_TAG=''
  reject 'empty latest response' 'latest' bash "$here/ci.sh" record-latest
  [ ! -s "$GITHUB_OUTPUT" ]
fi
printf 'CI guard tests passed (%s).\n' "$group"
