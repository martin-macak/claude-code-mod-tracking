#!/bin/sh
# Check a PR body (on stdin) against .github/pull_request_template.md.
# pr.yml runs it as the pr-body check. Rules: AGENTS.md, "Pull requests".
#   - A linked issue: Closes|Fixes|Resolves|Refs #N, or "None" under "Linked issue".
#   - Trivial, chore and ci PRs may omit the issue link.
#   - A "Requirements" section with at least one item, every item ticked.
#   - No unticked checkbox anywhere: an unticked box is an unverified claim.
# HTML comments (the template's hints) do not count.

set -u

body="$(cat | tr -d '\r' | perl -0pe 's/<!--.*?-->//gs')"
fail=0

err() {
  printf '::error::%s\n' "$1"
  fail=1
}

section() {
  printf '%s\n' "$body" | awk -v h="## $1" '
    $0 == h { on = 1; next }
    /^## / { on = 0 }
    on'
}

optional_issue_for_title() {
  printf '%s\n' "${TITLE:-}" | grep -Eq '^(trivial|chore|ci)(\([^)]+\))?:'
}

if ! optional_issue_for_title; then
  if ! printf '%s\n' "$body" | grep -Eqi '(close[sd]?|fix(e[sd])?|resolve[sd]?|refs) #[0-9]+'; then
    if section 'Linked issue' | grep -Eqi '^[[:space:]]*none'; then
      err 'Issue links are required for this PR type. Replace "None" with "Closes #N" or another issue reference.'
    else
      err 'Link the issue: "Closes #N" (or Fixes, Refs).'
    fi
  fi
fi

reqs="$(section Requirements | grep -E '^[[:space:]]*- \[[ xX]\]')"
if [ -z "$reqs" ]; then
  err 'Add a "## Requirements" section. One ticked item per requirement of the issue, with the test that proves it.'
fi

open="$(printf '%s\n' "$body" | grep -E '^[[:space:]]*- \[ \]')"
if [ -n "$open" ]; then
  err "Tick every checkbox, or remove the line and say why. Unticked:"
  printf '%s\n' "$open"
fi

[ "$fail" = 0 ] && echo 'PR body: OK'
exit "$fail"
