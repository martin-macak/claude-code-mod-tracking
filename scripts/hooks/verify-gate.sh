#!/bin/sh
# Agent gate: no push and no finish without a green `make verify`.
# Rules: AGENTS.md, "Before you commit or push".
#
# Callers (event JSON on stdin):
#   .github/hooks/verify.json  Copilot preToolUse and agentStop
#   .claude/settings.json      Claude Code PreToolUse on Bash
#
# Usage: verify-gate.sh pre-tool | stop
#   pre-tool  Deny `git push`, Copilot's report_progress and hook bypasses until
#             make verify passes. Other tool calls pass through.
#   stop      Block the end of a Copilot session that left red checks, uncommitted
#             changes or unpushed commits.
#
# Deny: exit 2, JSON on stdout (Copilot), reason on stderr (Claude Code).
# A pass is cached per tree state in .git/verify-gate.stamp.

set -u

mode="${1:-pre-tool}"
input="$(cat)"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

deny() {
  jq -cn --arg r "$1" '{permissionDecision: "deny", permissionDecisionReason: $r}'
  printf '%s\n' "$1" >&2
  exit 2
}

block() {
  jq -cn --arg r "$1" '{decision: "block", reason: $r}'
  exit 0
}

# Hash of HEAD, tracked changes and untracked files. Same state, same hash.
tree_state() {
  {
    git rev-parse HEAD 2>/dev/null
    git diff HEAD --binary 2>/dev/null
    git ls-files -o --exclude-standard -z | xargs -0 cat 2>/dev/null
  } | git hash-object --stdin
}

# Run make verify unless this tree state passed before. On failure, print the tail.
run_verify() {
  stamp="$(git rev-parse --git-path verify-gate.stamp)"
  state="$(tree_state)"
  [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$state" ] && return 0
  log="$(mktemp)"
  if make verify >"$log" 2>&1; then
    rm -f "$log"
    # A fixer may have changed files. Stamp the state after the run.
    tree_state >"$stamp"
    return 0
  fi
  tail -n 40 "$log"
  rm -f "$log"
  return 1
}

fail_text() {
  printf 'make verify failed. Fix the cause, stage the fixer changes, run make verify again. Never bypass the hooks. Output tail:\n%s' "$1"
}

if [ "$mode" = stop ]; then
  # A session that changed nothing has nothing to check.
  if [ -z "$(git status --porcelain)" ] \
    && [ "$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)" = 0 ]; then
    exit 0
  fi
  if ! out="$(run_verify)"; then block "$(fail_text "$out")"; fi
  if [ -n "$(git status --porcelain)" ]; then
    block "The tree has uncommitted changes (maybe from a lint fixer). Review them, commit and push them, then finish."
  fi
  if git rev-parse -q --verify '@{u}' >/dev/null 2>&1 && [ "$(git rev-list --count '@{u}..HEAD')" != 0 ]; then
    block "HEAD has commits that are not pushed. Push them, then finish."
  fi
  exit 0
fi

# pre-tool: Copilot sends toolName/toolArgs or tool_name/tool_input, Claude Code sends
# tool_name/tool_input. toolArgs can be a JSON string.
tool="$(printf '%s' "$input" | jq -r '.toolName // .tool_name // empty' 2>/dev/null)"
cmd="$(printf '%s' "$input" | jq -r '
  (.toolArgs // .tool_input // {}) as $a
  | ($a | if type == "string" then (try fromjson catch {command: .}) else . end) as $o
  | ($o.command // "") | tostring' 2>/dev/null)"

case "$tool" in
  report_progress) ;;
  bash | Bash)
    # Match real invocations only, so text that mentions the flags (a heredoc) passes.
    if printf '%s\n' "$cmd" | grep -Eq \
      -e 'git[^|;&]*[[:space:]](commit|push|merge|rebase|am|cherry-pick)[[:space:]][^|;&]*--no-verify' \
      -e 'git[^|;&]*[[:space:]]commit[[:space:]]([^|;&]*[[:space:]])?-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$)' \
      -e '(^|[;&|[:space:]])SKIP=[^[:space:]]*[[:space:]]+(git|pre-commit|make)([[:space:]]|$)' \
      -e 'git[[:space:]][^|;&]*core\.hooksPath'; then
      deny "Do not bypass the git hooks (--no-verify, SKIP=, core.hooksPath). Fix the cause. Rules: AGENTS.md."
    fi
    printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_-])git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+push([[:space:]]|$)' || exit 0
    ;;
  *) exit 0 ;;
esac

if ! out="$(run_verify)"; then deny "$(fail_text "$out")"; fi
exit 0
