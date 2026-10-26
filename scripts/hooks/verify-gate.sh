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
#             condition (if, elif, while, until) or in a case branch counts. A read of
#             core.hooksPath (git config --get core.hooksPath) is not a bypass. Other
#             tool calls pass through.
#   stop      Block the end of a Copilot session that left red checks, uncommitted
#             changes or unpushed commits.
#
# Where make verify runs (pre-tool): in the repo the push targets.
#   - The target comes from `git -C <dir>` and from a cd in the same command or
#     subshell. The scan is verify-gate-target.awk. It follows only literal paths, and
#     it gives up on anything it cannot follow with certainty.
#   - A relative path starts in the directory of the tool call: `cwd` of the hook input,
#     else the process directory. The session repo is the repo of that directory. When
#     that directory is in no repo, it is the repo of CLAUDE_PROJECT_DIR, else of the
#     process directory. With no repo at all, only a push that names a repo with the
#     gate is checked.
#   - A push with an unknown target runs make verify in the home repo: the session repo
#     when it holds the gate (scripts/hooks/verify-gate.sh), else the repo of
#     CLAUDE_PROJECT_DIR or of the process directory when that holds the gate. So does a
#     push that GIT_DIR, GIT_WORK_TREE, --git-dir or --work-tree can move, and a push to a
#     directory that has no repo after another command ran (it may have made one). The
#     gate never passes on doubt.
#   - A target in this repo (the home repo), or in a worktree of it, needs a passing make
#     verify in that worktree. A target in another repo needs one when the repo has the
#     gate. A target with no gate, or with no repo, passes.
#   - A session repo with no gate is another repo with no gate, as for any other target:
#     a plain push from its directory has nothing to check. With no home repo at all, an
#     unknown target has nothing to check too.
#
# Text is no command: verify-gate-heredoc.awk drops a heredoc body and a quoted string
# with a newline before any match, when a command that only reads text owns it (cat,
# tee, echo, printf, git commit, gh pr). Any other owner, a pipe, a group or loop, exec,
# eval, or a file that may be run later keeps it. The scan keeps the text on doubt about
# a file name (a glob, a brace, a substitution, a quote or a case that spells it another
# way). It cannot see a file that a later tool call runs, or a shell fed with file names
# that no word of the command spells (the awk header has the rules and the limits). If an
# awk script fails, the gate matches the command as it came.
#
# Deny: exit 2, JSON on stdout (Copilot), reason on stderr (Claude Code).
# A pass is cached per tree state in .git/verify-gate.stamp of the repo that ran it.
# On main, make verify fails in the no-commit-to-branch hook. The deny text says so.

set -u

mode="${1:-pre-tool}"
input="$(cat)"
case "$0" in
  */*) here="${0%/*}" ;;
  *) here=. ;;
esac
here="$(cd "${here:-/}" && pwd -P)"
nl='
'
sep="$(printf '\001')"
# The gh stack subcommands that push. The awk gets the list with -v.
gh_stack_push='push|submit|sync|merge|link'

# One jq call reads the tool, the directory and the command. Copilot sends
# toolName/toolArgs or tool_name/tool_input, Claude Code sends tool_name/tool_input.
# toolArgs can be a JSON string. The directory is the cwd of the hook input. It follows a
# cd of the Bash tool. The process directory may differ. A relative path in the command
# is relative to it, and so is the session repo.
parsed="$(printf '%s' "$input" | jq -j '
  (.toolArgs // .tool_input // {}) as $a
  | ($a | if type == "string" then (try fromjson catch {command: .}) else . end) as $o
  | [(.toolName // .tool_name // ""), (.cwd // ""), (try ($o.command // "") catch "")]
  | map(tostring | gsub("\u0001"; "")) | join("\u0001")' 2>/dev/null)"
tool="${parsed%%"$sep"*}"
rest="${parsed#*"$sep"}"
tool_cwd="${rest%%"$sep"*}"
cmd="${rest#*"$sep"}"

procdir="$(pwd -P)"
if [ -n "$tool_cwd" ] && [ -d "$tool_cwd" ]; then cd -P "$tool_cwd" 2>/dev/null || true; fi
startdir="$(pwd -P)"
root="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$root" ]; then
  # The directory of the tool call is in no repo (a cd moved it out). Use the repo of the project.
  for d in "${CLAUDE_PROJECT_DIR:-}" "$procdir"; do
    [ -n "$d" ] || continue
    root="$(cd "$d" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)"
    [ -z "$root" ] || break
  done
fi
# home: the repo where a push with no known target must pass make verify. It is the session
# repo when that holds the gate, like any other target. Else it is the repo of
# CLAUDE_PROJECT_DIR, or of the process directory, when that holds the gate. A tool
# directory that drifted into a repo with no gate does not hide a push of the project.
home=""
if [ -n "$root" ] && [ -f "$root/scripts/hooks/verify-gate.sh" ]; then
  home="$root"
else
  for d in "${CLAUDE_PROJECT_DIR:-}" "$procdir"; do
    [ -n "$d" ] || continue
    h="$(cd "$d" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)"
    if [ -n "$h" ] && [ -f "$h/scripts/hooks/verify-gate.sh" ]; then
      home="$h"
      break
    fi
  done
fi
if [ -n "$root" ]; then
  cd "$root" || exit 0
elif [ "$mode" = stop ]; then
  exit 0
fi
# "This repo" is the home repo and its worktrees.
root_common=""
if [ -n "$home" ]; then
  root_common="$(cd "$home" 2>/dev/null && c="$(git rev-parse --git-common-dir 2>/dev/null)" && cd -P "$c" 2>/dev/null && pwd -P)"
fi

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

# Run make verify in the directory $1 unless this tree state passed before there. On
# failure, print the tail of the output. The exit status is 3 when the no-commit-to-branch
# hook was the only one that failed (the checkout is on main), else 1.
run_verify() {
  (
    cd "$1" || exit 1
    stamp="$(git rev-parse --git-path verify-gate.stamp)"
    if [ -f "$stamp" ]; then
      IFS= read -r saved <"$stamp" || saved=""
      [ "$saved" = "$(tree_state)" ] && exit 0
    fi
    log="$(mktemp "${TMPDIR:-/tmp}/verify-gate-log.XXXXXX")"
    if make verify >"$log" 2>&1; then
      rm -f "$log"
      # A fixer may have changed files. Stamp the state after the run.
      tree_state >"$stamp"
      exit 0
    fi
    rc=1
    hooks="$(grep '^- hook id:' "$log")"
    if [ "$hooks" = '- hook id: no-commit-to-branch' ]; then rc=3; fi
    tail -n 40 "$log"
    rm -f "$log"
    exit "$rc"
  )
}

# The deny text. $1 is the directory where make verify ran, $2 the output of run_verify,
# $3 its exit status.
fail_text() {
  if [ "$1" = "$root" ]; then where=""; else where=" in $1"; fi
  if [ "$3" = 3 ]; then
    printf 'make verify failed%s because the checkout is on main. The no-commit-to-branch hook blocks main, so make verify cannot pass there. This is not a lint error. Create a branch (git switch -c <type>/<summary>), run make verify again, then push from that branch. Output tail:\n%s' "$where" "$2"
  else
    printf 'make verify failed%s. Fix the cause, stage the fixer changes, run make verify again. Never bypass the hooks. Output tail:\n%s' "$where" "$2"
  fi
}

# Drop the text that is no command from the command $1 (see the header). Only a command
# with a heredoc operator or a newline can hold such text. On an awk failure, keep it as
# it is.
strip_heredocs() {
  case "$1" in
    *'<<'* | *"$nl"*) ;;
    *)
      printf '%s' "$1"
      return 0
      ;;
  esac
  if body_free="$(printf '%s' "$1" | awk -f "$here/verify-gate-heredoc.awk" 2>/dev/null)"; then
    printf '%s' "$body_free"
  else
    printf '%s' "$1"
  fi
}

# Exit 0 when the command $1 holds a push-like command: git push, or gh stack
# push|submit|sync|merge|link, at a command position.
# A push-like command is at a command position after ;, &, |, (, ), { or a backtick, or
# at the start of a line. The ) is the end of a case pattern. A wrapper may come first
# (env, sudo, xargs, bash -c, VAR=1), or a keyword that runs the next command as a test or
# a body (if, elif, while, until, then, else, do). A wrapper may take options and
# arguments (env -i, sudo -u root, command --, timeout -s KILL 5, nice -n 10, bash -x -c).
# The gate does not parse them: any words up to the next operator may sit between the
# wrapper and the command. This errs toward a deny, and a deny only runs make verify.
# Text that only names the command (echo, a commit message) does not match.
push_match() {
  quote="[\"']"
  arg="(\"[^\"]*\"|'[^']*'|[^[:space:]]+)" # a quoted path may hold spaces
  start='(^|[;&|(){`])[[:space:]]*'
  words='([[:space:]]+[^[:space:];&|()`]+)*'
  shell_c='(bash|sh|zsh|dash)([[:space:]]+-[-a-z]+)*[[:space:]]+-[a-z]*c'
  wrap='(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|!|if|elif|while|until|then|else|do|(exec|command|sudo|doas|time|nohup|nice|ionice|timeout|gtimeout|setsid|stdbuf|caffeinate|env|xargs|eval)'"$words"'|'"$shell_c"')[[:space:]]+'"$quote"'?)*'
  end='([[:space:];&|)`"'"'"']|$)' # a closing quote ends the command in bash -c '...'
  printf '%s' "$1" | grep -Eq \
    -e "$start$wrap([^[:space:]]*/)?git([[:space:]]+(-[Cc][[:space:]]+$arg|--(git-dir|work-tree|namespace)[[:space:]]+$arg|-[^[:space:]]+))*[[:space:]]+push$end" \
    -e "$start$wrap([^[:space:]]*/)?gh[[:space:]]+stack[[:space:]]+($gh_stack_push)$end"
}

# Print the home repo, when there is one: where a push with no known target runs.
session_target() {
  if [ -n "$home" ]; then printf '%s\n' "$home"; fi
  return 0
}

# The directory where a push that runs in $1 (relative to the start directory) must
# pass make verify. Prints it, or prints nothing when there is no gate to run. A "!" in
# front of $1 says that another command ran before the push.
target_dir() {
  d="$1"
  after=0
  case "$d" in
    '!'*)
      after=1
      d="${d#!}"
      ;;
  esac
  if ! tdir="$(cd -P "$startdir" 2>/dev/null && cd -P "$d" 2>/dev/null && pwd -P)"; then
    session_target # no such directory: the cd fails and the push stays here
    return 0
  fi
  top="$(cd "$tdir" && git rev-parse --show-toplevel 2>/dev/null)"
  gc="$(cd "$tdir" && c="$(git rev-parse --git-common-dir 2>/dev/null)" && cd -P "$c" 2>/dev/null && pwd -P)"
  if [ -z "$gc" ]; then
    # No repo here: git push fails on its own. A command that ran first may have made one.
    if [ "$after" = 1 ]; then session_target; fi
    return 0
  fi
  if [ -n "$root_common" ] && [ "$gc" = "$root_common" ]; then
    printf '%s\n' "${top:-$home}" # this repo or a worktree of it
  elif [ -n "$top" ] && [ -f "$top/scripts/hooks/verify-gate.sh" ]; then
    printf '%s\n' "$top" # another repo that has the gate
  fi
}

# Print the directories where make verify must pass before the push-like command $1 runs.
# It runs in a command substitution, so its temp file and its trap are its own.
push_targets() {
  scan="$(mktemp "${TMPDIR:-/tmp}/verify-gate-scan.XXXXXX")"
  trap 'rm -f "$scan"' EXIT
  rest="$1"
  # Settings that move the repo defeat a path. Then every push stays in the session repo.
  moved="${GIT_DIR:-}${GIT_WORK_TREE:-}${GIT_COMMON_DIR:-}${CDPATH:-}"
  case "$1" in *GIT_DIR* | *GIT_WORK_TREE* | *GIT_COMMON_DIR* | *CDPATH*) moved=1 ;; esac
  if [ -z "$moved" ]; then
    if cut="$(printf '%s' "$1" | awk -v gh_stack_push="$gh_stack_push" -v out_dirs="$scan" -f "$here/verify-gate-target.awk" 2>/dev/null)"; then
      rest="$cut"
    else
      : >"$scan"
    fi
  fi
  # A push the scan could not place still runs in the session repo.
  if [ -n "$home" ] && push_match "$rest"; then printf '%s\n' "$home"; fi
  while IFS= read -r d; do
    [ -n "$d" ] && target_dir "$d"
  done <"$scan"
  rm -f "$scan"
  return 0
}

# core.hooksPath. Exit 0 when the command in $1 may change it, 1 when it is clean.
# Rule: a simple command that runs git and names core.hooksPath is denied, unless the
# whole command is a read. This is an allowlist. A deny list of write shapes misses
# `-c`, an alias, xargs, an env config, a value that starts with a dash and a read flag
# in a comment. Redirections go first, so a read flag cannot hide in a target. A
# process substitution stays, so it blocks a read shape. Then split on ; & |.
hookspath_bypass() {
  quote="[\"']"
  # No mention of the name, even with quotes or backslashes inside it: nothing to check.
  plainall="$(printf '%s' "$1" | tr -d "\"'\\\\")"
  case "$plainall" in
    *[Hh][Oo][Oo][Kk][Ss][Pp][Aa][Tt][Hh]*) ;;
    *) return 1 ;;
  esac
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
  res="$(run_verify "$root")"
  rc=$?
  if [ "$rc" -ne 0 ]; then block "$(fail_text "$root" "$res" "$rc")"; fi
  if [ -n "$(git status --porcelain)" ]; then
    block "The tree has uncommitted changes (maybe from a lint fixer). Review them, commit and push them, then finish."
  fi
  if git rev-parse -q --verify '@{u}' >/dev/null 2>&1 && [ "$(git rev-list --count '@{u}..HEAD')" != 0 ]; then
    block "HEAD has commits that are not pushed. Push them, then finish."
  fi
  exit 0
fi

# pre-tool
targets="$root"
case "$tool" in
  report_progress) [ -n "$root" ] || exit 0 ;;
  bash | Bash)
    # Text that is no command: a heredoc body, a quoted string.
    cmd="$(strip_heredocs "$cmd")"
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
    push_match "$cmd" || exit 0
    # Find where each push runs. No target with a gate: nothing to check.
    targets="$(push_targets "$cmd")"
    [ -n "$targets" ] || exit 0
    ;;
  *) exit 0 ;;
esac

# Run make verify in each target, once per directory. The first failure denies.
seen="$nl"
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  case "$seen" in *"$nl$dir$nl"*) continue ;; esac
  seen="$seen$dir$nl"
  res="$(run_verify "$dir")"
  rc=$?
  if [ "$rc" -ne 0 ]; then deny "$(fail_text "$dir" "$res" "$rc")"; fi
done <<EOF
$targets
EOF
exit 0
