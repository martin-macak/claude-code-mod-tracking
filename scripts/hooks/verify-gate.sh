#!/bin/sh
# Agent gate: no push and no finish without a green `make verify`.
# Rules: AGENTS.md, "Before you commit or push".
#
# Callers (event JSON on stdin):
#   .github/hooks/verify.json  Copilot preToolUse and agentStop
#   .claude/settings.json      Claude Code PreToolUse on Bash
#
# Usage: verify-gate.sh pre-tool | stop
#   pre-tool  Deny `git push`, `gh stack push|submit|sync|merge|link`, Copilot's
#             report_progress and hook bypasses until make verify passes. A push in a
#             condition (if, elif, while, until) counts. A read of
#             core.hooksPath (git config --get core.hooksPath) is not a bypass. Other
#             tool calls pass through.
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

# core.hooksPath. Exit 0 when the command in $1 may change it, 1 when it is clean.
# Rule: a simple command that runs git and names core.hooksPath is denied, unless the
# whole command is a read. This is an allowlist. A deny list of write shapes misses
# `-c`, an alias, xargs, an env config, a value that starts with a dash and a read flag
# in a comment. Redirections go first, so a read flag cannot hide in a target. A
# process substitution stays, so it blocks a read shape. Then split on ; & |.
hookspath_bypass() {
  quote="[\"']"
  # git [-C dir] config [read flags] core.hooksPath, and nothing else.
  read_config='^[[:space:]]*git([[:space:]]+-C[[:space:]]+[^[:space:]]+)*[[:space:]]+config[[:space:]]+((--get|--get-all|--get-regexp|--show-origin|--show-scope|--local|--global|--worktree|--system|--all|get)[[:space:]]+)*'"$quote"'?core\.hooksPath'"$quote"'?[[:space:]]*$'
  # git [-C dir] grep|log|show|diff|blame ..., with no substitution that could run more.
  read_search='^[[:space:]]*git([[:space:]]+-C[[:space:]]+[^[:space:]]+)*[[:space:]]+(grep|log|show|diff|blame)([[:space:]]|$)'
  # shellcheck disable=SC2020 # tr maps ; & | to newline one to one (POSIX)
  printf '%s\n' "$1" | sed -E 's/[0-9]*[<>]+&?[^[:space:](][^[:space:]]*//g' | tr ';&|' '\n\n\n' | {
    while IFS= read -r part; do
      # Quotes and backslashes can split the name (core.hooks"Path"). Drop them to look.
      plain="$(printf '%s' "$part" | tr -d "\"'\\\\")"
      printf '%s' "$plain" | grep -Eiq 'core\.hookspath' || continue
      printf '%s' "$plain" | grep -Eq '(^|[^[:alnum:]_.-])git([[:space:]]|$)' || continue
      printf '%s' "$part" | grep -Eq "$read_config" && continue
      if printf '%s' "$part" | grep -Eq "$read_search" \
        && ! printf '%s' "$part" | grep -Eq '\$\(|`|<\(|>\('; then
        continue
      fi
      exit 0
    done
    exit 1
  }
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
      -e '(^|[;&|[:space:]])SKIP=[^[:space:]]*[[:space:]]+(git|pre-commit|make)([[:space:]]|$)'; then
      deny "Do not bypass the git hooks (--no-verify, SKIP=, core.hooksPath). Fix the cause. Rules: AGENTS.md."
    fi
    if hookspath_bypass "$cmd"; then
      deny "Do not bypass the git hooks (--no-verify, SKIP=, core.hooksPath). Fix the cause. Rules: AGENTS.md."
    fi
    # A push-like command at a command position: after ;, &, |, ( or a backtick, or at
    # the start of a line. A wrapper may come first (env, sudo, xargs, bash -c, VAR=1), or
    # a keyword that runs the next command as a test or a body (if, elif, while, until,
    # then, else, do). A wrapper may take options and arguments (env -i, sudo -u root,
    # command --, timeout -s KILL 5, nice -n 10, bash -x -c). The gate does not parse
    # them: any words up to the next operator may sit between the wrapper and the
    # command. This errs toward a deny, and a deny only runs make verify. Text that only
    # names the command (echo, a commit message) does not match.
    quote="[\"']"
    start='(^|[;&|({`])[[:space:]]*'
    words='([[:space:]]+[^[:space:];&|()`]+)*'
    shell_c='(bash|sh|zsh|dash)([[:space:]]+-[-a-z]+)*[[:space:]]+-[a-z]*c'
    wrap='(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|!|if|elif|while|until|then|else|do|(exec|command|sudo|doas|time|nohup|nice|ionice|timeout|gtimeout|setsid|stdbuf|caffeinate|env|xargs|eval)'"$words"'|'"$shell_c"')[[:space:]]+'"$quote"'?)*'
    end='([[:space:];&|)`"'"'"']|$)' # a closing quote ends the command in bash -c '...'
    printf '%s' "$cmd" | grep -Eq \
      -e "$start$wrap([^[:space:]]*/)?git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|--(git-dir|work-tree|namespace)[[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+push$end" \
      -e "$start$wrap([^[:space:]]*/)?gh[[:space:]]+stack[[:space:]]+(push|submit|sync|merge|link)$end" || exit 0
    ;;
  *) exit 0 ;;
esac

if ! out="$(run_verify)"; then deny "$(fail_text "$out")"; fi
exit 0
