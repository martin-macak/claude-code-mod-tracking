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

run_case 'trivial issue optional' 'trivial: Remove a noisy log line' 0
run_case 'chore issue optional' 'chore: Make CI quieter' 0
run_case 'ci issue optional' 'ci: Refresh GitHub Actions' 0
run_case 'feat issue required' 'feat: Add new behavior' 1

printf 'all PR body checks passed\n'
