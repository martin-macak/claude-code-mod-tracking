#!/usr/bin/env bash
set -eu

here="$(cd "$(dirname "$0")" && pwd -P)"
script="$here/check-pr-body.sh"

make_body() {
  cat <<'EOF'
## Summary

- [x] Something small.

## Linked issue

None

## Requirements

- [x] A check for the change.

## Test plan

- [x] `make verify`
EOF
}

run_case() {
  local name=$1
  local title=$2
  local expect=$3
  local out
  local tmp
  tmp=$(mktemp)
  make_body >"$tmp"
  set +e
  out=$(TITLE="$title" "$script" <"$tmp" 2>&1)
  local status=$?
  set -e
  rm -f "$tmp"
  if [ "$status" -ne "$expect" ]; then
    printf 'FAIL %s: expected exit %s, got %s\n%s\n' "$name" "$expect" "$status" "$out"
    exit 1
  fi
  printf 'ok   %s (exit %s)\n' "$name" "$status"
}

# The PR template is the source of what authors paste into a body. The check reads no box text, so a body that is made
# from the template, or that still names `make e2e` in its Test plan, must pass. The open PRs say `make e2e`.
template="$here/../../.github/pull_request_template.md"

run_template_case() {
  local name=$1
  local expect=$2
  local filter=$3
  local out
  local status
  set +e
  out=$(sed -e 's/^- \[ \]/- [x]/' -e 's/^Closes #$/Closes #223/' -e "$filter" "$template" |
    TITLE='build(e2e): Add make e2e-safe' "$script" 2>&1)
  status=$?
  set -e
  if [ "$status" -ne "$expect" ]; then
    printf 'FAIL %s: expected exit %s, got %s\n%s\n' "$name" "$expect" "$status" "$out"
    exit 1
  fi
  printf 'ok   %s (exit %s)\n' "$name" "$status"
}

run_template_case 'the ticked and linked PR template passes' 0 's/^$//'
tick='`'
run_template_case 'a body that still names make e2e in the Test plan passes' 0 \
  "s/${tick}make e2e-safe${tick} after/${tick}make e2e${tick} after/"
run_template_case 'a body with an unticked box fails' 1 "s/^- \[x\] ${tick}make verify/- [ ] ${tick}make verify/"

run_case 'trivial issue optional' 'trivial: Remove a noisy log line' 0
run_case 'chore issue optional' 'chore: Make CI quieter' 0
run_case 'ci issue optional' 'ci: Refresh GitHub Actions' 0
run_case 'feat issue required' 'feat: Add new behavior' 1

printf 'all PR body checks passed\n'
