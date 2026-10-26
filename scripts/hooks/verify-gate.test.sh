#!/usr/bin/env bash
# Test scripts/hooks/verify-gate.sh in pre-tool mode.
# The session repo has a `verify` target that always fails. A gated command is
# denied (exit 2). A command the gate ignores passes (exit 0). A push that targets
# another repo is gated there, not in the session repo.
#
# The cases are recorded first, then run in parallel (VERIFY_GATE_TEST_JOBS, default
# the CPU count, at most 8). A case runs the gate once and never changes a fixture, so
# the order does not matter. The cases that run the gate twice or read a file the gate
# writes (the stamp cache, the temp files) run after them, one by one. The suite
# builds each hook input in bash, with no jq process per case.
# VERIFY_GATE_TEST_FILTER='regex' runs only the cases whose name matches the regex.
# shellcheck disable=SC2016 # the cases are literal command text; nothing should expand
set -u

# The gate reads these. A value from the caller would change what a case tests.
unset CLAUDE_PROJECT_DIR GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE CDPATH

here="$(cd "$(dirname "$0")" && pwd -P)"
gate="$here/verify-gate.sh"

# Fixtures. The gate runs in $repo. It holds the gate script, and its `verify` target
# always fails, so a gated push in $repo is denied. The other repos show where the gate
# looks:
#   wt       a worktree of $repo (its verify fails: same Makefile)
#   wtok     a worktree of $repo whose verify passes
#   other    a repo with no gate (no Makefile, no scripts/hooks/verify-gate.sh)
#   nogate   a repo with a failing verify target but no gate script
#   gated    a repo with the gate and a failing verify
#   passing  a repo with the gate and a passing verify
#   mainrepo a repo with the gate whose verify fails like no-commit-to-branch on main
#   mainlint a repo with the gate whose verify fails in a lint hook and in no-commit-to-branch
#   spaced   a repo with the gate and a failing verify, with a space in its path
#   spaced_ok  the same, with a passing verify
#   plain    a directory that is no repo
#   bare     a bare repo
#   link     a symlink to $repo
#   x/linksub  a symlink to $repo/sub, in a plain directory
#   x/linkother  a symlink to $other
#   cdp/other  a repo with the gate and a failing verify, under the name of $other
base="$(mktemp -d)"
trap 'rm -rf "$base"' EXIT
repo="$base/repo"
git_t() { git -c user.name=t -c user.email=t@t "$@"; }
mkrepo() { # dir verify_exit_code [gate]
  mkdir -p "$1"
  git -C "$1" init -q
  printf 'verify:\n\t@exit %s\n' "$2" >"$1/Makefile"
  if [ "${3:-}" = gate ]; then
    mkdir -p "$1/scripts/hooks"
    : >"$1/scripts/hooks/verify-gate.sh"
  fi
}
mkrepo "$repo" 1 gate
git -C "$repo" add Makefile scripts
git_t -C "$repo" commit -q -m init
mkdir -p "$repo/sub"
git -C "$repo" worktree add -q "$base/wt" -b wt-branch
git -C "$repo" worktree add -q "$base/wtok" -b wtok-branch
printf 'verify:\n\t@exit 0\n' >"$base/wtok/Makefile"
mkdir -p "$base/other/sub"
git -C "$base/other" init -q
mkrepo "$base/nogate" 1
mkrepo "$base/gated" 1 gate
mkrepo "$base/passing" 0 gate
mkrepo "$base/mainrepo" 1 gate
cat >"$base/mainrepo/Makefile" <<'MK'
verify:
	@printf "don't commit to branch....Failed\n- hook id: no-commit-to-branch\n- exit code: 1\n"; exit 1
MK
mkrepo "$base/mainlint" 1 gate
cat >"$base/mainlint/Makefile" <<'MK'
verify:
	@printf "biome check....Failed\n- hook id: biome\n- exit code: 1\ndon't commit to branch....Failed\n- hook id: no-commit-to-branch\n- exit code: 1\n"; exit 1
MK
mkrepo "$base/sp ace" 1 gate
mkrepo "$base/sp ace ok" 0 gate
mkrepo "$base/cdp/other" 1 gate
mkdir -p "$base/plain" "$base/x" "$base/tmp"
git init -q --bare "$base/bare"
ln -s "$repo" "$base/link"
ln -s "$repo/sub" "$base/x/linksub"
ln -s "$base/other" "$base/x/linkother"
# A copy of the gate with no awk script next to it: both awk calls fail.
mkdir -p "$base/gate-no-awk"
cp "$gate" "$base/gate-no-awk/verify-gate.sh"
other="$base/other" nogate="$base/nogate" gated="$base/gated" passing="$base/passing"
wt="$base/wt" wtok="$base/wtok" plain="$base/plain" bare="$base/bare" link="$base/link"
mainrepo="$base/mainrepo" mainlint="$base/mainlint" spaced="$base/sp ace" spaced_ok="$base/sp ace ok"
gate_no_awk="$base/gate-no-awk/verify-gate.sh"
nl=$'\n'
tab=$'\t'

failed=0

# The case table. Each field is an array, indexed by the case number.
n=0
c_kind=() c_name=() c_dir=() c_input=() c_expect=() c_has=() c_hasnot=() c_env=() c_gate=()
add_case() { # kind name dir input expect has hasnot env gate
  c_kind[n]=$1
  c_name[n]=$2
  c_dir[n]=$3
  c_input[n]=$4
  c_expect[n]=$5
  c_has[n]=${6:-}
  c_hasnot[n]=${7:-}
  c_env[n]=${8:-}
  c_gate[n]=${9:-$gate}
  n=$((n + 1))
}

# json_str text: set REPLY to the JSON string of the text (the text has no control
# character but newline, tab and carriage return).
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  REPLY="\"$s\""
}

# mk_input cwd command: set REPLY to the hook input of a Bash tool call. An empty cwd
# leaves the field out.
mk_input() {
  local cwdpart="" cmd
  if [ -n "$1" ]; then
    json_str "$1"
    cwdpart=",\"cwd\":$REPLY"
  fi
  json_str "$2"
  cmd=$REPLY
  REPLY="{\"tool_name\":\"Bash\"$cwdpart,\"tool_input\":{\"command\":$cmd}}"
}

# The input builder must agree with jq on a hard string. A bug here would test nothing.
hard=$'a "quoted" \\ back\tslash\nnew line $x `y`'
mk_input "$base/a b" "$hard"
if [ "$(printf '%s' "$REPLY" | jq -r '.tool_input.command')" != "$hard" ] \
  || [ "$(printf '%s' "$REPLY" | jq -r '.cwd')" != "$base/a b" ]; then
  echo 'FAIL the suite builds a hook input that jq reads differently'
  exit 1
fi

# run_case name command expected_exit
run_case() {
  mk_input "" "$2"
  add_case pre "$1" "$repo" "$REPLY" "$3"
}

# run_cwd name process_dir json_cwd command expected_exit
# Runs the gate in process_dir. The hook input names json_cwd as the directory of the
# Bash tool, as Claude Code and Copilot do. The gate must follow json_cwd.
run_cwd() {
  mk_input "$3" "$4"
  add_case pre "$1" "$2" "$REPLY" "$5"
}

# run_msg name dir command expected_exit must_contain [must_not_contain]
# Checks the exit status and the deny text on stderr. With an empty must_contain it
# only runs the command in dir.
run_msg() {
  mk_input "" "$3"
  add_case pre "$1" "$2" "$REPLY" "$4" "$5" "${6:-}"
}

# run_env name dir VAR=value command expected_exit [json_cwd [must_contain_in_deny_text]]
# Runs the gate with VAR=value in its own environment.
run_env() {
  mk_input "${6:-}" "$4"
  add_case pre "$1" "$2" "$REPLY" "$5" "${7:-}" "" "$3"
}

# run_json name json dir expected_exit [VAR=value]
# Sends the hook input as it is, for the shapes that Claude Code does not send.
run_json() {
  add_case pre "$1" "$3" "$2" "$4" "" "" "${5:-}"
}

# run_gate name gate_path command expected_exit
# Runs another copy of the gate in $repo.
run_gate() {
  mk_input "" "$3"
  add_case pre "$1" "$repo" "$REPLY" "$4" "" "" "" "$2"
}

# run_stop name dir must_contain [json]
# Stop mode blocks the end of a session with a red verify. It names the same causes.
run_stop() {
  local json=${4:-}
  if [ -z "$json" ]; then json='{}'; fi
  add_case stop "$1" "$2" "$json" 0 "$3"
}

# exec_case i: run case i and write one result line to $base/res/i.
exec_case() {
  local i=$1 g="${c_gate[$1]}" out status line
  if [ "${c_kind[$i]}" = stop ]; then
    out="$(cd "${c_dir[$i]}" && printf '%s' "${c_input[$i]}" | "$g" stop 2>/dev/null)"
    if [[ $out != *'"decision":"block"'* ]] || [[ $out != *"${c_has[$i]}"* ]]; then
      line="FAIL ${c_name[$i]}: stop output lacks a block with \"${c_has[$i]}\": $out"
    else
      line="ok   ${c_name[$i]}"
    fi
  else
    if [ -n "${c_env[$i]}" ]; then
      out="$(cd "${c_dir[$i]}" && printf '%s' "${c_input[$i]}" | env "${c_env[$i]}" "$g" pre-tool 2>&1 >/dev/null)"
    else
      out="$(cd "${c_dir[$i]}" && printf '%s' "${c_input[$i]}" | "$g" pre-tool 2>&1 >/dev/null)"
    fi
    status=$?
    if [ "$status" -ne "${c_expect[$i]}" ]; then
      line="FAIL ${c_name[$i]}: expected exit ${c_expect[$i]}, got $status"
    elif [ -n "${c_has[$i]}" ] && [[ $out != *"${c_has[$i]}"* ]]; then
      line="FAIL ${c_name[$i]}: deny text lacks \"${c_has[$i]}\": $out"
    elif [ -n "${c_hasnot[$i]}" ] && [[ $out == *"${c_hasnot[$i]}"* ]]; then
      line="FAIL ${c_name[$i]}: deny text has \"${c_hasnot[$i]}\": $out"
    else
      line="ok   ${c_name[$i]} (exit $status)"
    fi
  fi
  printf '%s\n' "$line" >"$base/res/$i"
}

# wanted name: true when no filter is set, or the name matches the filter. The filter is
# a bash regex in VERIFY_GATE_TEST_FILTER. It runs a group of cases: for example
# VERIFY_GATE_TEST_FILTER='^heredoc' scripts/hooks/verify-gate.test.sh
wanted() {
  [ -z "${VERIFY_GATE_TEST_FILTER:-}" ] || [[ $1 =~ ${VERIFY_GATE_TEST_FILTER} ]]
}

# run_all: run every recorded case, in parallel, and print the results in case order.
run_all() {
  local jobs="${VERIFY_GATE_TEST_JOBS:-}" k i line
  if [ -z "$jobs" ]; then jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"; fi
  case $jobs in '' | *[!0-9]*) jobs=4 ;; esac
  if [ "$jobs" -gt 8 ]; then jobs=8; fi
  if [ "$jobs" -lt 1 ]; then jobs=1; fi
  mkdir -p "$base/res"
  for ((k = 0; k < jobs; k++)); do
    (for ((i = k; i < n; i += jobs)); do wanted "${c_name[$i]}" && exec_case "$i"; done) &
  done
  wait
  for ((i = 0; i < n; i++)); do
    wanted "${c_name[$i]}" || continue
    if [ -f "$base/res/$i" ]; then
      line="$(<"$base/res/$i")"
    else
      line="FAIL ${c_name[$i]}: the case produced no result"
    fi
    case $line in FAIL*) failed=1 ;; esac
    printf '%s\n' "$line"
  done
}

# now dir command: run the gate in dir at once, in the serial part. Sets status.
now() {
  mk_input "" "$2"
  (cd "$1" && printf '%s' "$REPLY" | "$gate" pre-tool >/dev/null 2>&1)
  status=$?
}

# Push-like commands: gated.
run_case 'gh stack push' 'gh stack push' 2
run_case 'gh stack submit' 'gh stack submit --auto' 2
run_case 'gh stack sync' 'gh stack sync --prune' 2
run_case 'gh stack merge' 'gh stack merge --yes --squash' 2
run_case 'git push' 'git push --force-with-lease origin feat/x' 2
run_case 'gh stack push in a chain' 'make verify && gh stack push' 2
# A push-like command followed by an operator, a bracket or the end is still a push.
run_case 'gh stack push; next' 'gh stack push; echo done' 2
run_case 'gh stack submit&& next' 'gh stack submit&& echo done' 2
run_case 'gh stack sync | tee' 'gh stack sync|tee log' 2
run_case 'gh stack push in a subshell' '(gh stack push)' 2
run_case 'gh stack submit in a substitution' 'x=$(gh stack submit)' 2
run_case 'git push; next' 'git push; echo done' 2
run_case 'git push&& next' 'git push&&echo done' 2
run_case 'git push | tee' 'git push|tee log' 2
run_case 'git push in a subshell' '(git push)' 2
run_case 'git push after a global option with an argument' 'git --work-tree . push' 2
# Wrappers in front of the command do not hide it.
run_case 'env prefix' 'env GIT_TRACE=1 git push' 2
run_case 'variable prefix' 'GIT_TRACE=1 gh stack submit' 2
run_case 'xargs' 'echo origin | xargs git push' 2
run_case 'bash -c' "bash -c 'git push origin feat/x'" 2
run_case 'sh -c, push ends at the quote' "sh -c 'git push'" 2
run_case 'bash -c, gh stack ends at the quote' 'bash -c "gh stack submit"' 2
run_case 'sudo' 'sudo git push' 2
run_case 'full path' '/usr/bin/git push' 2
# A wrapper with its own options and arguments does not hide the command either.
run_case 'env -i' 'env -i git push' 2
run_case 'env -u with an argument' 'env -u GIT_DIR git push origin feat/x' 2
run_case 'env -i, variable, gh stack' 'env -i HOME=/tmp gh stack submit' 2
run_case 'sudo -u with an argument' 'sudo -u root git push' 2
run_case 'sudo -E' 'sudo -E gh stack push' 2
run_case 'command --' 'command -- git push' 2
run_case 'time -p' 'time -p git push' 2
run_case 'exec -a with an argument' 'exec -a pusher git push' 2
run_case 'xargs -n 1' 'echo origin | xargs -n 1 git push' 2
run_case 'wrappers in a row' 'sudo -u root env -i git push' 2
run_case 'wrapper with options in a chain' 'make verify && env -i git push' 2
run_case 'wrapper with options in a subshell' '(sudo -u root gh stack link feat/a feat/b)' 2
run_case 'wrapper with options in bash -c' "bash -c 'env -i git push'" 2
run_case 'sudo -u, then bash -c' "sudo -u root bash -c 'git push'" 2
run_case 'bash -x -c' "bash -x -c 'git push'" 2
run_case 'bash --norc -c' 'bash --norc -c "gh stack submit"' 2
# Runners that main's gate caught by accident: nice, ionice, timeout, doas, setsid, stdbuf, caffeinate.
run_case 'nice' 'nice git push' 2
run_case 'nice -n 10' 'nice -n 10 git push' 2
run_case 'ionice -c 3' 'ionice -c 3 git push' 2
run_case 'timeout 5' 'timeout 5 git push' 2
run_case 'timeout -s KILL 5' 'timeout -s KILL 5 git push origin feat/x' 2
run_case 'gtimeout 5' 'gtimeout 5 git push' 2
run_case 'doas' 'doas git push' 2
run_case 'doas -u root' 'doas -u root git push' 2
run_case 'setsid' 'setsid git push' 2
run_case 'setsid -f' 'setsid -f git push' 2
run_case 'stdbuf -o0' 'stdbuf -o0 git push' 2
run_case 'caffeinate -i' 'caffeinate -i git push' 2
run_case 'nice -n 10, gh stack submit' 'nice -n 10 gh stack submit' 2
run_case 'timeout 30, gh stack push' 'timeout 30 gh stack push' 2
run_case 'timeout -s KILL 30, gh stack sync' 'timeout -s KILL 30 gh stack sync' 2
run_case 'doas, gh stack link' 'doas gh stack link feat/a feat/b' 2
run_case 'setsid, gh stack merge' 'setsid gh stack merge --yes --squash' 2
run_case 'stdbuf -oL, gh stack push' 'stdbuf -oL gh stack push' 2
run_case 'timeout, then env' 'timeout 5 env -i git push' 2
run_case 'timeout in a chain' 'make verify && timeout 5 git push' 2
run_case 'timeout in bash -c' "bash -c 'timeout 5 git push'" 2
# gh stack link pushes the branch arguments before it creates the PRs.
run_case 'gh stack link' 'gh stack link feat/a feat/b' 2
run_case 'gh stack link, PR numbers' 'gh stack link 41 42 43 --open' 2
run_case 'gh stack link in a chain' 'make verify && gh stack link feat/a feat/b' 2
# A push used as a shell condition is still a push.
run_case 'if git push' 'if git push; then echo ok; fi' 2
run_case 'if ! git push' 'if ! git push origin feat/x; then exit 1; fi' 2
run_case 'if gh stack push' 'if gh stack push; then echo ok; fi' 2
run_case 'elif git push' 'if false; then :; elif git push; then echo ok; fi' 2
run_case 'while git push' 'while git push; do sleep 1; done' 2
run_case 'until gh stack push' 'until gh stack push; do sleep 1; done' 2
run_case 'until gh stack link' 'until gh stack link feat/a feat/b; do sleep 1; done' 2
run_case 'if after a newline' 'echo go
if git push; then echo ok; fi' 2
run_case 'then after a push-free test' 'if test -f x; then git push; fi' 2
run_case 'brace group' '{ git push; }' 2

# Text that only names a push-like command: pass.
run_case 'echo names gh stack submit' 'echo "run gh stack submit later"' 0
run_case 'commit message names git push' 'git commit -m "Never run git push by hand"' 0
run_case 'git stash push' 'git stash push -m wip' 0
run_case 'gh stack rebase' 'gh stack rebase --upstack' 0
run_case 'env -i on a command that does not push' 'env -i make test' 0
run_case 'sudo -u on a command that does not push' 'sudo -u root make install' 0
run_case 'wrapper, then a push-free step' 'env -i make test; echo done' 0
run_case 'echo names a wrapper and a push' 'echo "sudo -u root git push"' 0
run_case 'commit message names a wrapper and a push' 'git commit -m "Never run sudo -u root git push"' 0
run_case 'bash -x -c on a command that does not push' "bash -x -c 'make test'" 0
run_case 'timeout on a read-only command' 'timeout 5 git status' 0
run_case 'timeout -s on a command that does not push' 'timeout -s KILL 30 make test' 0
run_case 'nice on a command that does not push' 'nice -n 10 make test' 0
run_case 'doas on a command that does not push' 'doas make install' 0
run_case 'stdbuf on a command that does not push' 'stdbuf -o0 make test' 0
run_case 'setsid, then a push-free step' 'setsid make test; echo done' 0
run_case 'echo names a runner and a push' 'echo "timeout 5 git push"' 0
run_case 'commit message names a runner and a push' 'git commit -m "Never run timeout 5 git push by hand"' 0
run_case 'git commit' 'git commit -m "feat: Add x"' 0
run_case 'git config user' 'git config user.name "A B"' 0

# Read-only commands: pass.
run_case 'gh stack view' 'gh stack view' 0
run_case 'gh stack view --json' 'gh stack view --json' 0
run_case 'gh stack checkout' 'gh stack checkout feat/x' 0
run_case 'if on a read-only test' 'if git status --short; then echo ok; fi' 0
run_case 'while on a read-only test' 'while git diff --quiet; do sleep 1; done' 0
run_case 'if names git push in a message' 'if true; then git commit -m "Never run git push by hand"; fi' 0
run_case 'echo names a condition on gh stack link' 'echo "until gh stack link x y; do :; done"' 0
run_case 'gh pr view' 'gh pr view 12' 0
run_case 'git config --get hooksPath' 'git config --get core.hooksPath' 0
run_case 'git config --get-all hooksPath' 'git config --get-all core.hooksPath' 0
run_case 'git config --list' 'git config --list' 0
run_case 'git config --get hooksPath, quoted' 'git config --get "core.hooksPath"' 0
run_case 'git config read, stderr dropped' 'git config core.hooksPath 2>/dev/null' 0
run_case 'git config bare read' 'git config core.hooksPath' 0
run_case 'git config --show-origin read' 'git config --show-origin --get core.hooksPath' 0
run_case 'git config --local read' 'git config --local core.hooksPath' 0
run_case 'git -C read' 'git -C sub config --get core.hooksPath' 0
run_case 'git config read, then another command' 'git config --get core.hooksPath && git status' 0
run_case 'git grep names hooksPath' 'git grep -n core.hooksPath scripts' 0
run_case 'git log -S names hooksPath' 'git log --oneline -S core.hooksPath' 0

# Hook bypasses: denied.
run_case 'git config hooksPath write' 'git config core.hooksPath /tmp/x' 2
run_case 'git config --global hooksPath write' 'git config --global core.hooksPath /tmp/x' 2
run_case 'git config read, then write' 'git config --get core.hooksPath && git config core.hooksPath /tmp/x' 2
run_case 'git -c hooksPath' 'git -c core.hooksPath=/dev/null commit -m x' 2
run_case 'git -c hooksPath, quoted' 'git -c "core.hooksPath=/dev/null" commit -m x' 2
run_case 'git config hooksPath write, quoted name' 'git config "core.hooksPath" /tmp/x' 2
run_case 'git --config-env hooksPath' 'git --config-env=core.hooksPath=V commit -m x' 2
# A read flag must not hide a write: in a comment, a redirect target or a here-string.
run_case 'write, read flag in a comment' 'git config core.hooksPath /tmp/x # --get' 2
run_case 'write, read flag as redirect target' 'git config core.hooksPath /tmp/x > --get' 2
run_case 'write, read flag in a here-string' 'git config core.hooksPath /tmp/x <<< --get' 2
# A value that starts with a dash is still a write.
run_case 'write, value after --' 'git config core.hooksPath -- /tmp/x' 2
# The git token is not the first word, or the config is set in another way.
run_case 'write through xargs' 'echo /tmp/x | xargs git config core.hooksPath' 2
run_case 'write through an alias' "git -c alias.hp='config core.hooksPath /tmp/x' hp" 2
run_case 'git -c, empty quotes before the key' 'git -c ""core.hooksPath=/dev/null commit -m x' 2
run_case 'write, process substitution as value' 'git config core.hooksPath <(echo /tmp/x)' 2
run_case 'write, empty value' 'git config core.hooksPath ""' 2
run_case 'write, set subcommand' 'git config set core.hooksPath /tmp/x' 2
run_case 'write, key in other case' 'git config core.hookspath /tmp/x' 2
run_case 'write, key split by quotes' 'git config core.hooks"Path" /tmp/x' 2
run_case 'write, env config' 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/x git commit -m x' 2
run_case 'git grep with a write inside a substitution' 'git grep $(git config core.hooksPath /tmp/x)' 2
run_case 'git commit --no-verify' 'git commit --no-verify -m x' 2

# Heredoc bodies are text, not commands. Only a body that a shell reads is a command.
run_case 'heredoc body: push in a subshell' "cat > f <<'EOF'${nl}(cd /tmp/x && git push)${nl}EOF" 0
run_case 'heredoc body: push line' "cat > f <<'EOF'${nl}git push origin main${nl}EOF" 0
run_case 'heredoc body: gh stack line' "cat > f <<'EOF'${nl}gh stack submit${nl}EOF" 0
run_case 'heredoc body: unquoted delimiter' "cat > f <<EOF${nl}git push origin main${nl}EOF" 0
run_case 'heredoc body: double-quoted delimiter' "cat > f <<\"EOF\"${nl}git push${nl}EOF" 0
run_case 'heredoc body: backslash delimiter' "cat > f <<\\EOF${nl}git push${nl}EOF" 0
run_case 'heredoc body: space before the delimiter' "cat > f << 'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: <<- and a tab terminator' "cat <<-EOF${nl}${tab}git push${nl}${tab}EOF" 0
run_case 'heredoc body: two heredocs on one line' "cat <<'A' <<'B'${nl}git push${nl}A${nl}(git push)${nl}B" 0
run_case 'heredoc body: quoted delimiter, substitution is text' "cat <<'EOF'${nl}\$(git push)${nl}EOF" 0
run_case 'heredoc body: file named notes.md' "cat > ./notes.md <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: file under /tmp' "cat > /tmp/notes.txt <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: gh pr create body' "gh pr create --body-file - <<'EOF'${nl}Run git push later.${nl}git push origin x${nl}EOF" 0
run_case 'heredoc body: commit message names a push' "git commit -m \"\$(cat <<'EOF'${nl}fix: x${nl}${nl}Never run git push by hand.${nl}git push origin main${nl}EOF${nl})\"" 0
run_case 'heredoc body names --no-verify' "git commit -F - <<'EOF'${nl}Never use git commit --no-verify.${nl}EOF" 0
run_case 'heredoc body names SKIP=' "cat > f <<'EOF'${nl}SKIP=lint git commit -m x${nl}EOF" 0
run_case 'heredoc body names core.hooksPath' "cat > f <<'EOF'${nl}git config core.hooksPath /tmp/x${nl}EOF" 0
# Text outside the body is still a command.
run_case 'heredoc: push after the terminator' "cat > f <<'EOF'${nl}text${nl}EOF${nl}git push" 2
run_case 'heredoc: push before the operator' "git push${nl}cat > f <<'EOF'${nl}text${nl}EOF" 2
run_case 'heredoc: push on the operator line' "git push <<EOF${nl}body${nl}EOF" 2
run_case 'heredoc: push chained on the operator line' "cat > f <<'EOF' && git push${nl}body${nl}EOF" 2
run_case 'heredoc: push in front of the operator' "git push; cat <<'EOF'${nl}x${nl}EOF" 2
run_case 'heredoc: --no-verify on the operator line' "git commit --no-verify -F - <<'EOF'${nl}x${nl}EOF" 2
run_case 'heredoc: unterminated, body stays' "cat <<'EOF'${nl}git push" 2
run_case 'heredoc: terminator with trailing text is no terminator' "cat <<'EOF'${nl}git push${nl}EOF x${nl}" 2
run_case 'heredoc: terminator with leading space is no terminator' "cat <<'EOF'${nl}git push${nl} EOF${nl}" 2
run_case 'heredoc: <<- needs tabs, not spaces' "cat <<-EOF${nl}git push${nl}  EOF${nl}" 2
# A << that is no heredoc operator hides nothing.
run_case 'no heredoc: here-string' "cat <<< x${nl}git push${nl}EOF" 2
run_case 'no heredoc: single-quoted <<' "echo '<<EOF'${nl}git push${nl}EOF" 2
run_case 'no heredoc: double-quoted <<' "echo \"<<EOF\"${nl}git push${nl}EOF" 2
run_case 'no heredoc: single-quoted << with spaces' "echo ' <<EOF '${nl}git push${nl}EOF" 2
run_case 'no heredoc: double-quoted << with spaces' "echo \" <<EOF \"${nl}git push${nl}EOF" 2
run_case 'no heredoc: escaped <' "echo \\<<EOF${nl}git push${nl}EOF" 2
run_case 'no heredoc: comment' "# <<EOF${nl}git push${nl}EOF" 2
run_case 'no heredoc: arithmetic shift' "echo \$((1<<2))${nl}git push${nl}2" 2
# A body that a command runs is a command.
run_case 'heredoc runs: bash' "bash <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: sh -s' "sh -s <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: /bin/zsh' "/bin/zsh <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: piped to sh' "cat <<'EOF' | sh${nl}git push${nl}EOF" 2
run_case 'heredoc runs: piped to bash with a path' "cat <<'EOF' | /usr/bin/env bash${nl}git push${nl}EOF" 2
run_case 'heredoc runs: eval' "eval \"\$(cat <<'EOF'${nl}git push${nl}EOF${nl})\"" 2
run_case 'heredoc runs: source' "source /dev/stdin <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: dot' ". /dev/stdin <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: script written, then run with bash' "cat > /tmp/p.sh <<'EOF'${nl}git push${nl}EOF${nl}bash /tmp/p.sh" 2
run_case 'heredoc runs: script written, then sourced' "cat > /tmp/p.sh <<'EOF'${nl}git push${nl}EOF${nl}source /tmp/p.sh" 2
run_case 'heredoc runs: script written, then run by path' "cat > run.sh <<'EOF'${nl}git push${nl}EOF${nl}chmod +x run.sh && ./run.sh" 2
run_case 'heredoc runs: script with no extension, run by path' "cat > run <<'EOF'${nl}git push${nl}EOF${nl}chmod +x run${nl}./run" 2
run_case 'heredoc runs: absolute script path' "cat > /tmp/run <<'EOF'${nl}git push${nl}EOF${nl}/tmp/run" 2
run_case 'heredoc runs: a .sh file is written' "cat > run.sh <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a .bash file is written' "cat > run.bash <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: unquoted delimiter with a substitution' "cat <<EOF${nl}\$(git push)${nl}EOF" 2
run_case 'heredoc runs: unquoted delimiter with a backtick' "cat <<EOF${nl}\`git push\`${nl}EOF" 2

# A body is text only when the command that owns the heredoc reads text: cat, tee,
# git commit, gh pr. Another command, a pipe, or a file that is run later keeps it.
run_case 'heredoc body: git add a .sh file, then git commit -F -' "git add scripts/hooks/verify-gate.sh && git commit -F - <<'EOF'${nl}(cd /tmp/x && git push)${nl}EOF" 0
run_case 'heredoc body: cat to a .md file, then a .sh test run' "cat > f.md <<'EOF'${nl}git push${nl}EOF${nl}bash scripts/hooks/verify-gate.test.sh" 0
run_case 'heredoc body: tee by an absolute path' "/usr/bin/tee /tmp/f.md <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: a directory named sh' "cat > docs/sh/a.md <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: gh issue comment' "gh issue comment 1 --body-file - <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: git tag -F -' "git tag -a v1 -F - <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: git -C commit' "git -C \"$repo\" commit -F - <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: git notes add' "git notes add -F - <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: gh api --input -' "gh api repos/o/r/issues/1/comments --input - <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: gh release create' "gh release create v1 --notes-file - <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: gh gist create' "gh gist create - <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: a redirect of a descriptor in front of cat' "2>/dev/null cat <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: a redirect in front of cat' "> f cat <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: a file name inside a longer name is no reference' "cat > run <<'EOF'${nl}git push${nl}EOF${nl}echo myrun" 0
run_case 'heredoc body: cat after a cd' "cd /tmp && cat > f <<'EOF'${nl}git push${nl}EOF" 0
run_case 'heredoc body: gh pr create in a substitution' "gh pr create --body \"\$(cat <<'EOF'${nl}git push${nl}EOF${nl})\"" 0
run_case 'heredoc body: stderr redirect' "cat > f 2>/dev/null <<'EOF'${nl}git push${nl}EOF" 0
# A reader that is no text sink keeps the body. The list of shells is no list of readers.
run_case 'heredoc runs: $SHELL' "\$SHELL <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: "$BASH"' "\"\$BASH\" <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: sudo -s' "sudo -s <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: su' "su \$USER <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: script' "script -q /dev/null <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: make -f -' "make -f - <<'EOF'${nl}all:${nl}${tab}git push${nl}EOF" 2
run_case 'heredoc runs: while read' "while read -r l; do \$l; done <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: ssh' "ssh localhost <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: python' "python3 - <<'EOF'${nl}import os${nl}os.system(\"true;git push\")${nl}EOF" 2
run_case 'heredoc runs: perl' "perl <<'EOF'${nl}\`git push\`${nl}EOF" 2
run_case 'heredoc runs: xargs sh' "xargs -I{} sh -c {} <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a name run through PATH' "cat > run <<'EOF'${nl}git push${nl}EOF${nl}PATH=.:\$PATH run" 2
run_case 'heredoc runs: a name run through a variable' "cat > run <<'EOF'${nl}git push${nl}EOF${nl}x=run; \$x" 2
run_case 'heredoc runs: the file is read back by eval' "cat > f <<'EOF'${nl}git push${nl}EOF${nl}eval \"\$(cat f)\"" 2
run_case 'heredoc runs: piped to $SHELL' "cat <<'EOF' | \$SHELL${nl}git push${nl}EOF" 2
run_case 'heredoc runs: piped to tee' "cat <<'EOF' | tee f${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a pipe into the command' "echo x | cat <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: into a process substitution' "cat <<'EOF' > >(sh)${nl}git push${nl}EOF" 2
run_case 'heredoc runs: output to a variable file' "cat > \"\$f\" <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: output to a descriptor' "cat >&3 <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a substitution that $SHELL runs' "\$SHELL -c \"\$(cat <<'EOF'${nl}git push${nl}EOF${nl})\"" 2
run_case 'heredoc runs: a substitution that python runs' "python3 -c \"\$(cat <<'EOF'${nl}os.system('true;git push')${nl}EOF${nl})\"" 2
run_case 'heredoc runs: a substitution in an assignment' "x=\$(cat <<'EOF'${nl}git push${nl}EOF${nl}); \$x" 2
run_case 'heredoc runs: a command word that is a wrapper' "env cat <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a command word with a variable' "\$c <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a variable assignment in front' "X=1 cat <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: git with an alias that may run it' "git -c alias.x='!sh' x <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: git with another subcommand' "git am <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: gh with another subcommand' "gh alias set x <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a subshell group' "(cat <<'EOF'${nl}git push${nl}EOF${nl}) | sh" 2
run_case 'heredoc runs: a function stands for cat' "cat() { sh; }; cat <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a function with a subshell body stands for cat' "cat() ( sh ); cat <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a function with the function keyword and a subshell body' "function cat ( sh ); cat <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a function with the function keyword' "function cat { sh; }; cat <<'EOF'${nl}git push${nl}EOF" 2
run_case 'string: a function stands for echo' "echo() { sh -c \"\$1\"; }; echo \"a${nl}git push\"" 2
run_case 'heredoc runs: the enclosing command writes a file that is run' "echo \"\$(cat <<'EOF'${nl}git push${nl}EOF${nl})\" > run${nl}PATH=.:\$PATH run" 2
run_case 'heredoc runs: tee with more than eight words' "tee a b c d e f g h run <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a process substitution in front' ">(sh) cat <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a sh file written by tee' "tee run.sh <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: tee, then the file is run' "tee run <<'EOF'${nl}git push${nl}EOF${nl}PATH=.:\$PATH run" 2
# A text command writes a file, and the rest of the command runs it by a name that it does
# not spell: a glob, a brace, a quote or a backslash inside the name, a substitution, a
# file system that folds case, a list of names that xargs or parallel reads, a FIFO. The
# body stays in the match for each. The rule costs a deny only when the body holds push text.
hd_run="cat > run <<'EOF'${nl}git push${nl}EOF${nl}"
run_case 'heredoc runs: a name given by a glob' "${hd_run}bash r*" 2
run_case 'heredoc runs: a name given by a ? glob' "${hd_run}bash ru?" 2
run_case 'heredoc runs: a name given by a [ ] glob' "${hd_run}bash ./r[u]n" 2
run_case 'heredoc runs: a glob of every file' "${hd_run}source ./*" 2
run_case 'heredoc runs: a name given by a brace' "${hd_run}bash {r,x}un" 2
run_case 'heredoc runs: a name split by single quotes' "${hd_run}bash 'r''un'" 2
run_case 'heredoc runs: a name split by double quotes' "${hd_run}bash \"r\"un" 2
run_case 'heredoc runs: a name split by a backslash' "${hd_run}bash r\\un" 2
run_case 'heredoc runs: a name split by a backslash and a newline' "${hd_run}bash r\\${nl}un" 2
run_case 'heredoc runs: a name in other case (a file system that folds case)' "${hd_run}bash RUN" 2
run_case 'heredoc runs: a name written in other case' "cat > RUN <<'EOF'${nl}git push${nl}EOF${nl}bash run" 2
run_case 'heredoc runs: a name given by a substitution' "${hd_run}bash \$(echo ru)n" 2
run_case 'heredoc runs: a name given by a backtick' "${hd_run}bash \`echo ru\`n" 2
run_case 'heredoc runs: a name from ls and a glob' "${hd_run}source \$(ls r*)" 2
run_case 'heredoc runs: a name from ls and grep' "${hd_run}bash \$(ls | grep r)" 2
run_case 'heredoc runs: xargs reads the names' "${hd_run}ls | xargs -n1 bash" 2
run_case 'heredoc runs: parallel reads the names' "${hd_run}ls | parallel bash" 2
run_case 'heredoc runs: find -exec' "${hd_run}find . -name 'r*' -exec bash {} \\;" 2
run_case 'heredoc runs: a FIFO, the reader opens it first' "mkfifo ff; bash < ff & cat > ff <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a FIFO made by mknod' "mknod ff p; bash < ff & cat > ff <<'EOF'${nl}git push${nl}EOF" 2
# The owner may write to a descriptor or a device that a shell reads.
run_case 'heredoc runs: a descriptor file' "cat > /dev/fd/3 <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a /proc file' "cat > /proc/self/fd/3 <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc body: a write to /dev/null' "cat > /dev/null <<'EOF'${nl}git push${nl}EOF${nl}echo \"done\"" 0
# A group or a loop pipes or redirects the output of everything in it, and exec redirects
# the shell itself. The body stays in the match.
run_case 'heredoc runs: a brace group piped to sh' "{${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}} | sh" 2
run_case 'heredoc runs: a while loop piped to sh' "while true; do${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}break${nl}done | sh" 2
run_case 'heredoc runs: an until loop piped to sh' "until false; do${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}break${nl}done | sh" 2
run_case 'heredoc runs: a for loop piped to sh' "for i in 1; do${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}done | sh" 2
run_case 'heredoc runs: a select loop piped to sh' "select i in 1; do${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}break${nl}done | sh" 2
run_case 'heredoc runs: an if block piped to sh' "if true; then${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}fi | sh" 2
run_case 'heredoc runs: a case block piped to sh' "case x in x)${nl}cat <<'EOF'${nl}git push${nl}EOF${nl};; esac | sh" 2
run_case 'heredoc runs: a brace group after time, piped to sh' "time {${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}} | sh" 2
run_case 'heredoc runs: a brace group after !, piped to sh' "! {${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}} | sh" 2
run_case 'heredoc runs: a loop after time, piped to sh' "time while true; do${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}break${nl}done | sh" 2
run_case 'heredoc runs: a brace group written to a file that is run' "{${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}} > run${nl}bash run" 2
run_case 'heredoc runs: exec redirects the output to a file that is run' "exec > run${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}bash run" 2
run_case 'heredoc runs: command exec redirects the output' "command exec > run${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}bash run" 2
run_case 'heredoc runs: eval runs an exec' "eval 'exec > run'${nl}cat <<'EOF'${nl}git push${nl}EOF${nl}bash run" 2
# A quote or a plain word after the file does not keep the body.
run_case 'heredoc body: a quoted message after the file' "${hd_run}git commit -m \"Add notes\"" 0
run_case 'heredoc body: a quoted word after the file, other case' "${hd_run}echo \"MyRun\" 'x'" 0
# Each heredoc is judged by its own command. A text sink keeps the other one apart.
run_case 'heredoc: one body is text, the other feeds a shell' "cat <<'A'; sh <<'B'${nl}git push${nl}A${nl}git push${nl}B" 2
run_case 'heredoc: one body feeds a shell, the other is text' "sh <<'A'; cat <<'B'${nl}echo hi${nl}A${nl}git push${nl}B" 0
# A quoted string with a newline is text too, under the same rule. A shell or an
# interpreter may run it.
run_case 'string: a push line in printf' "printf '%s' \"first${nl}git push origin main${nl}last\"" 0
run_case 'string: a push line in echo, single quotes' "echo 'a${nl}git push${nl}b'" 0
run_case 'string: a push line in a commit message' "git commit -m \"subject${nl}${nl}git push origin main${nl}\"" 0
run_case 'string: a push line in gh pr create' "gh pr create --title t --body \"a${nl}(cd /tmp/x && git push)${nl}b\"" 0
run_case 'string: gh stack line in printf' "printf '%s' 'a${nl}gh stack submit${nl}b'" 0
run_case 'string: the push after the string stays' "printf '%s' \"a${nl}b\" && git push" 2
run_case 'string: the push before the string stays' "git push && printf '%s' \"a${nl}b\"" 2
run_case 'string: the push on the next line stays' "printf '%s' \"a${nl}b\"${nl}git push" 2
run_case 'string: bash -c with a script' "bash -c \"echo hi${nl}git push${nl}\"" 2
run_case 'string: sh -c with single quotes' "sh -c 'echo hi${nl}git push'" 2
run_case 'string: eval' "eval \"echo hi${nl}git push\"" 2
run_case 'string: $SHELL -c' "\$SHELL -c \"echo hi${nl}git push\"" 2
run_case 'string: python -c' "python3 -c \"import os${nl}os.system('true;git push')\"" 2
run_case 'string: awk program' "awk 'BEGIN{${nl}system(\"true; git push\")${nl}}'" 2
run_case 'string: ssh command' "ssh host \"echo hi${nl}git push\"" 2
run_case 'string: tmux send-keys' "tmux send-keys \"a${nl}git push\" Enter" 2
run_case 'string: piped to sh' "printf '%s' \"a${nl}git push\" | sh" 2
run_case 'string: piped to a variable shell' "printf '%s' \"a${nl}git push\" | \$SHELL" 2
run_case 'string: written to a file, run through PATH' "printf '%s' \"a${nl}git push${nl}\" > run; PATH=.:\$PATH run" 2
run_case 'string: written to a .sh file' "printf '%s' \"a${nl}git push${nl}\" > run.sh" 2
run_case 'string: written to a file in a variable' "printf '%s' \"a${nl}git push${nl}\" > \"\$f\"" 2
run_case 'string: command substitution inside' "printf '%s' \"a${nl}\$(git push)${nl}b\"" 2
run_case 'string: backtick inside' "printf '%s' \"a${nl}\`git push\`${nl}b\"" 2
run_case 'string: substitution in a parameter' "printf '%s' \"a${nl}\${x:-\$(git push)}${nl}b\"" 2
run_case 'string: unterminated' "printf '%s' \"a${nl}git push" 2
run_case 'string: unterminated, single quote' "printf '%s' 'a${nl}git push" 2
run_case 'string: a wrapper in front' "env printf '%s' \"a${nl}git push${nl}b\"" 2
run_case 'string: a variable assignment in front' "X=1 printf '%s' \"a${nl}git push${nl}b\"" 2
run_case 'string: an assignment of the string, used later' "x=\"a${nl}git push${nl}b\"; bash -c \"\$x\"" 2
run_case 'string: a heredoc and a string' "cat <<'EOF'${nl}text${nl}EOF${nl}bash -c \"a${nl}git push\"" 2
run_case 'string: written to a file, run by a glob' "printf '%s' \"a${nl}git push${nl}\" > run; bash r*" 2
run_case 'string: written to a file, run by a split name' "printf '%s' \"a${nl}git push${nl}\" > run; bash 'r''un'" 2
run_case 'string: written to a file, run in other case' "printf '%s' \"a${nl}git push${nl}\" > run; bash RUN" 2
run_case 'string: written to a file, xargs reads the names' "printf '%s' \"a${nl}git push${nl}\" > run; ls | xargs bash" 2
run_case 'string: written to a FIFO that a reader opened first' "mkfifo ff; bash < ff & printf '%s' \"a${nl}git push${nl}\" > ff" 2
run_case 'string: a quoted message after the file' "printf '%s' \"a${nl}git push${nl}\" > notes.txt; echo \"done\"" 0
# printf -v stores the text in a variable. A later command may run it.
run_case 'string: printf -v stores it, a shell runs it' "printf -v x '%s' \"a${nl}git push${nl}b\"; bash -c \"\$x\"" 2
run_case 'string: printf with a quoted -v' "printf '-v' x '%s' \"a${nl}git push${nl}b\"; bash -c \"\$x\"" 2
run_case 'string: printf with an option that is no -v' "printf -- '%s' \"a${nl}git push${nl}b\"" 0
# A group or a subshell around the reader: the redirect feeds its first command.
run_case 'heredoc runs: a subshell with the redirect' "( sh ) <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a subshell, a list, the redirect' "( bash; ) <<'EOF'${nl}git push${nl}EOF" 2
run_case 'heredoc runs: a pipeline in a subshell with the redirect' "( cat | sh ) <<'EOF'${nl}git push${nl}EOF" 2
run_case 'string: a subshell with a here-string' "( sh ) <<< \"a${nl}git push${nl}b\"" 2
# A case branch is a command position: the paren of a pattern ends before it.
run_case 'case: a push in a branch' 'case x in x) git push;; esac' 2
run_case 'case: no space after the paren' 'case x in x)git push;; esac' 2
run_case 'case: a pattern list' 'case x in a|x) git push;; esac' 2
run_case 'case: gh stack in a branch' 'case x in x) gh stack push;; esac' 2
run_case 'case: a wrapped push in a branch' 'case x in x) sudo git push;; esac' 2
run_case 'case: the push on the next line' "case x in${nl}  x) git push ;;${nl}esac" 2
run_case 'case: a second branch' 'case x in y) echo no;; x) git push;; esac' 2
run_case 'case: a branch with no push' 'case x in x) echo "git push";; esac' 0
run_case 'case: a branch that names a push in a message' 'case x in x) git commit -m "Never run git push";; esac' 0
# A heredoc and a push to another repo in one command: the push is gated where it runs.
run_case 'heredoc then -C a repo with no gate' "cat > f <<'EOF'${nl}x${nl}EOF${nl}git -C \"$other\" push" 0
run_case 'heredoc then cd a repo with no gate' "cat > f <<'EOF'${nl}x${nl}EOF${nl}cd \"$other\" && git push" 0
run_case 'heredoc then -C a repo with the gate' "cat > f <<'EOF'${nl}x${nl}EOF${nl}git -C \"$gated\" push" 2
run_case 'heredoc then -C a passing repo' "cat > f <<'EOF'${nl}x${nl}EOF${nl}git -C \"$passing\" push" 0
run_case 'heredoc then a push here' "cat > f <<'EOF'${nl}x${nl}EOF${nl}git push" 2
run_case 'heredoc, a body that is kept, then -C a repo with no gate' "bash <<'EOF'${nl}x${nl}EOF${nl}git -C \"$other\" push" 2
run_case 'heredoc, an expanding body, then -C a repo with no gate' "cat <<EOF${nl}\$(date)${nl}EOF${nl}git -C \"$other\" push" 2
run_case 'heredoc, two bodies, then -C a repo with no gate' "cat <<'A' <<'B'${nl}x${nl}A${nl}y${nl}B${nl}git -C \"$other\" push" 0
run_case 'heredoc, a here-string and a body, then -C a repo with no gate' "cat <<< x; cat <<'B'${nl}y${nl}B${nl}git -C \"$other\" push" 0

# A push is gated in the repo it targets. $repo (the session repo) has a failing
# verify. This repo and its worktrees: gated there.
run_case 'target: -C a subdir of this repo' "git -C \"$repo/sub\" push" 2
run_case 'target: -C this repo' "git -C \"$repo\" push" 2
run_case 'target: -C dot' 'git -C . push' 2
run_case 'target: -C path with a dot' "git -C \"$repo/.\" push" 2
run_case 'target: -C path with ..' "git -C \"$repo/sub/..\" push" 2
run_case 'target: -C leaves and returns' "git -C \"$other/../repo\" push" 2
run_case 'target: -C a symlink to this repo' "git -C \"$link\" push" 2
run_case 'target: -C the .git dir of this repo' "git -C \"$repo/.git\" push" 2
run_case 'target: cd the .git dir of this repo' "cd \"$repo/.git\" && git push" 2
run_case 'target: -C relative subdir' 'git -C sub push' 2
run_case 'target: cd relative subdir' 'cd sub && git push' 2
run_case 'target: cd relative subdir; push' 'cd sub; git push' 2
run_case 'target: cd subdir, -C back up' 'cd sub && git -C .. push' 2
run_case 'target: cd out and back' "cd \"$other\" && cd ../repo && git push" 2
run_case 'target: cd this repo' "cd \"$repo\" && git push" 2
run_case 'target: gh stack in this repo' "cd \"$repo\" && gh stack push" 2
run_case 'target: -C a worktree of this repo' "git -C \"$wt\" push" 2
run_case 'target: cd a worktree of this repo' "cd \"$wt\" && git push" 2
run_case 'target: subshell cd a worktree' "(cd \"$wt\" && git push)" 2
run_case 'target: relative -C a worktree' 'git -C ../wt push' 2
run_case 'target: gh stack in a worktree' "(cd \"$wt\" && gh stack submit)" 2
# The gate runs make verify in the worktree the push targets.
run_case 'target: -C a worktree with a passing verify' "git -C \"$wtok\" push" 0
run_case 'target: cd a worktree with a passing verify' "cd \"$wtok\" && git push" 0
run_case 'target: relative cd to a worktree with a passing verify' 'cd ../wtok && git push' 0
# Another repo: gated there when it has the gate, else the push passes.
run_case 'target: -C a repo with no gate' "git -C \"$other\" push" 0
run_case 'target: -C a subdir of a repo with no gate' "git -C \"$other/sub\" push" 0
run_case 'target: relative -C a repo with no gate' 'git -C ../other push' 0
run_case 'target: relative cd to a repo with no gate' 'cd ../other && git push' 0
run_case 'target: subshell cd, dry run' "(cd \"$other\" && git push --dry-run origin main)" 0
run_case 'target: cd &&' "cd \"$other\" && git push" 0
run_case 'target: cd ;' "cd \"$other\"; git push" 0
run_case 'target: cd, newline' "cd \"$other\"${nl}git push" 0
run_case 'target: cd &&, newline' "cd \"$other\" &&${nl}git push" 0
run_case 'target: cd -P' "cd -P \"$other\" && git push" 0
run_case 'target: cd --' "cd -- \"$other\" && git push" 0
run_case 'target: cd, other steps, push' "cd \"$other\" && git status && git push" 0
run_case 'target: cd, a step, ; push' "cd \"$other\" && git log; git push" 0
run_case 'target: true && cd && push' "true && cd \"$other\" && git push" 0
run_case 'target: cd, subshell push' "cd \"$other\" && (git push)" 0
run_case 'target: cd, push in the background' "cd \"$other\" && git push &" 0
run_case 'target: absolute cd after a pipe' "ls | cat; cd \"$other\" && git push" 0
run_case 'target: cd, redirect and pipe' "cd \"$other\" && git push 2>&1 | tail -3" 0
run_case 'target: -C, redirects' "git -C \"$other\" push >/dev/null 2>&1" 0
run_case 'target: -C, redirect before the subcommand' "git -C \"$other\" 2>/dev/null push" 0
run_case 'target: -C in a subshell' "(git -C \"$other\" push)" 0
run_case 'target: -C with -c' "git -c push.default=simple -C \"$other\" push" 0
run_case 'target: -C twice' "git -C \"$other\" -C . push" 0
run_case 'target: -C, then -C absolute' "git -C \"$repo\" -C \"$other\" push" 0
run_case 'target: single-quoted path' "git -C '$other' push" 0
run_case 'target: gh stack push' "cd \"$other\" && gh stack push" 0
run_case 'target: gh stack submit in a subshell' "(cd \"$other\" && gh stack submit)" 0
run_case 'target: gh stack link' "cd \"$other\" && gh stack link feat/a feat/b" 0
run_case 'target: a repo with a failing verify and no gate' "git -C \"$nogate\" push" 0
run_case 'target: a dir that is no repo' "git -C \"$plain\" push" 0
run_case 'target: a bare repo' "git -C \"$bare\" push" 0
run_case 'target: two repos with no gate' "git -C \"$other\" push && git -C \"$nogate\" push" 0
run_case 'target: a repo with the gate, verify fails' "git -C \"$gated\" push" 2
run_case 'target: cd a repo with the gate, verify fails' "(cd \"$gated\" && git push)" 2
run_case 'target: a path with a space, -C' "git -C \"$spaced\" push" 2
run_case 'target: a path with a space, cd' "cd \"$spaced\" && git push" 2
run_case 'target: a path with a space, single quotes' "git -C '$spaced' push" 2
run_case 'target: a repo with the gate, verify passes' "git -C \"$passing\" push" 0
run_case 'target: cd a repo with the gate, verify passes' "cd \"$passing\" && git push" 0
run_case 'target: two repos, the second fails' "git -C \"$passing\" push && git -C \"$gated\" push" 2
run_case 'target: two repos, the first fails' "git -C \"$gated\" push && git -C \"$passing\" push" 2
run_case 'target: no gate, then a gated repo' "git -C \"$other\" push && git -C \"$gated\" push" 2
# A cd or -C reaches only the command it belongs to. The rest runs in the session repo.
run_case 'scope: subshell cd ends at the paren' "(cd \"$other\"); git push" 2
run_case 'scope: subshell cd, a step, then push' "(cd \"$other\" && git log); git push" 2
run_case 'scope: -C binds to its command' "git -C \"$other\" log; git push" 2
run_case 'scope: push in another repo, then here' "git -C \"$other\" push; git push" 2
run_case 'scope: subshell push, then here' "(cd \"$other\" && git push) && git push" 2
run_case 'scope: cd away, push, cd back, push' "cd \"$other\" && git push && cd \"$repo\" && git push" 2
run_case 'scope: the last cd wins' "cd \"$other\"; cd \"$repo\"; git push" 2
run_case 'scope: the last -C wins' "git -C \"$other\" -C \"$repo\" push" 2
run_case 'scope: -C beats an earlier cd' "cd \"$other\" && git -C \"$repo\" push" 2
run_case 'scope: cd after ||' "cd \"$other\" || git push" 2
run_case 'scope: cd in a pipe' "cd \"$other\" | git push" 2
run_case 'scope: cd in the background' "cd \"$other\" & git push" 2
run_case 'scope: cd in the background, push on the next line' "cd \"$other\" &${nl}git push" 2
run_case 'scope: relative cd after a pipe' 'ls | cat; cd sub && git push' 2
run_case 'scope: cd that may not run' "[ -d x ] && cd \"$other\"; git push" 2
run_case 'scope: cd after ||, push after ;' "false || cd \"$other\"; git push" 2
run_case 'scope: cd in a condition' "if true; then cd \"$other\"; fi; git push" 2
run_case 'scope: cd in a loop' "for d in x; do cd \"$other\"; git push; done" 2
run_case 'scope: cd in a function' "f() { cd \"$repo\"; }; cd \"$other\"; f; git push" 2
run_case 'scope: eval cd' "cd \"$other\"; eval 'cd $repo'; git push" 2
run_case 'scope: source' "cd \"$other\"; source ./x.sh; git push" 2
run_case 'scope: pushd' "pushd \"$other\" && git push" 2
run_case 'scope: builtin cd' "cd \"$other\"; builtin cd \"$repo\"; git push" 2
run_case 'scope: command cd' "cd \"$other\"; command cd \"$repo\"; git push" 2
run_case 'scope: cd with a variable assignment' "cd \"$other\"; X=1 cd \"$repo\"; git push" 2
run_case 'scope: cd -' 'cd - && git push' 2
run_case 'scope: cd with no argument' 'cd && git push' 2
run_case 'scope: cd with two arguments' "cd \"$other\" \"$repo\" && git push" 2
# These start in a repo that passes and cd back into the session repo, which fails. A
# scan that kept the first directory would pass them.
run_case 'scope: cd in an if, then a cd back' "cd \"$passing\"; if true; then cd \"$repo\"; fi; git push" 2
run_case 'scope: cd in a for loop, then a cd back' "cd \"$passing\"; for d in x; do cd \"$repo\"; done; git push" 2
run_case 'scope: cd in a while loop, then a cd back' "cd \"$passing\"; while true; do cd \"$repo\"; break; done; git push" 2
run_case 'scope: cd in a brace group, then a cd back' "cd \"$passing\" && { cd \"$repo\"; }; git push" 2
run_case 'scope: cd after a negation' "cd \"$passing\"; ! cd \"$repo\"; git push" 2
run_case 'scope: cd after time' "cd \"$passing\"; time cd \"$repo\"; git push" 2
run_case 'scope: cd - after a cd' "cd \"$passing\"; cd -; git push" 2
run_case 'scope: cd with a variable after a cd' "cd \"$passing\"; cd \$OLDPWD; git push" 2
run_case 'scope: cd after a step that may fail' "test -d nonexistent && cd \"$passing\"; git push" 2
run_case 'scope: cd after a subshell that may fail' "(false) && cd \"$passing\"; git push" 2
run_case 'scope: a variable as the command word' "cd \"$other\"; \$X; git push" 2
run_case 'scope: a cd after a cd with a variable, push after ;' "cd \$X && cd \"$other\"; git push" 2
run_case 'scope: a function with the function keyword, called later' "function f { cd \"$repo\"; }; cd \"$other\"; f; git push" 2
# A path the gate cannot read with certainty is gated in the session repo.
run_case 'path: missing dir for cd' 'cd /nonexistent && git push' 2
run_case 'path: missing dir for cd, push after ;' 'cd /nonexistent; git push' 2
run_case 'path: missing dir for -C' 'git -C /nonexistent push' 2
run_case 'path: empty -C' 'git -C "" push' 2
run_case 'path: variable in -C' 'git -C "$X" push' 2
run_case 'path: unquoted variable in -C' 'git -C $X push' 2
run_case 'path: literal dollar in -C' "git -C '\$X' push" 2
run_case 'path: tilde in -C' 'git -C ~/x push' 2
run_case 'path: tilde in cd' 'cd ~/x && git push' 2
run_case 'path: glob in -C' "git -C $base/* push" 2
run_case 'path: brace in -C' "git -C $base/{other,repo} push" 2
run_case 'path: substitution in -C' "git -C \"\$(echo $other)\" push" 2
run_case 'path: backtick in cd' "cd \`echo $other\` && git push" 2
run_case 'path: ANSI-C quote in -C' "git -C \$'$other' push" 2
run_case 'path: dash-led -C' 'git -C -x push' 2
run_case 'path: substitution elsewhere in the command' "echo \$(true) && git -C \"$other\" push" 2
run_case 'path: push inside a substitution' "echo \$(cd \"$other\" && git push)" 2
run_case 'path: push in the arguments of a push' "cd \"$other\" && git push \$(git -C \"$repo\" push)" 2
run_case 'path: heredoc operator in the command' "cd \"$other\" && git push <<EOF${nl}x${nl}EOF" 2
# Settings that move the repo defeat a path.
run_case 'env: GIT_DIR prefix' "GIT_DIR=\"$repo/.git\" git -C \"$other\" push" 2
run_case 'env: export GIT_DIR' "export GIT_DIR=$repo/.git; git -C \"$other\" push" 2
run_case 'env: GIT_WORK_TREE' "GIT_WORK_TREE=$repo git -C \"$other\" push" 2
run_case 'env: --git-dir before -C' "git --git-dir \"$repo/.git\" -C \"$other\" push" 2
run_case 'env: --git-dir after -C' "git -C \"$other\" --git-dir=$repo/.git push" 2
run_case 'env: --work-tree after -C' "git -C \"$other\" --work-tree \"$repo\" push" 2
run_case 'env: CDPATH' "CDPATH=$base; cd other && git push" 2
# A wrapper or a nested shell hides the real cwd. The gate falls back to the session repo.
run_case 'wrapper: env' "cd \"$other\" && env -i git push" 2
run_case 'wrapper: sudo' "cd \"$other\" && sudo git push" 2
run_case 'wrapper: timeout' "cd \"$other\" && timeout 5 git push" 2
run_case 'wrapper: bash -c' "cd \"$other\" && bash -c 'git push'" 2
run_case 'wrapper: bash -c with its own cd' "cd \"$other\" && bash -c 'cd \"$repo\" && git push'" 2
run_case 'wrapper: xargs' "cd \"$other\" && echo origin | xargs git push" 2
run_case 'wrapper: brace group' "cd \"$other\" && { git push; }" 2
run_case 'wrapper: time' "cd \"$other\" && time git push" 2
run_case 'wrapper: negation' "cd \"$other\" && ! git push" 2
run_case 'wrapper: unbalanced paren' "cd \"$other\"; git push)" 2
run_case 'wrapper: unterminated quote' "cd \"$other\"; echo 'x; git push" 2
run_case 'wrapper: case statement' "cd \"$other\"; case x in x) cd \"$repo\";; esac; git push" 2

# A cd or a pipe on the left of || or | can skip or hide a later cd. The push still runs.
run_case 'scope: cd after ||, push after &&' "true || cd \"$other\" && git push" 2
run_case 'scope: cd after a pipe, push after &&' "true | cd \"$other\" && git push" 2
run_case 'scope: cd after |&, push after &&' "true |& cd \"$other\" && git push" 2
run_case 'scope: cd later in a list with ||' "false || true && cd \"$other\" && git push" 2
run_case 'scope: cd after ||, in the same list, with -C' "true || cd \"$other\" && git -C . push" 2
run_case 'scope: ; ends the list: cd is sure' "true || echo x; cd \"$other\" && git push" 0
run_case 'scope: subshell after ||: the cd stays inside' "true || (cd \"$other\" && git push)" 0
run_case 'scope: cd after || in a subshell, push after the paren' "true || (cd \"$other\"); cd \"$repo\" && git push" 2
run_case 'scope: ||, a subshell, then a cd that may be skipped' "true || (cd \"$wt\") && cd \"$other\" && git push" 2

# The hook input names the directory of the Bash tool. The process directory can differ.
run_cwd 'cwd: the session repo comes from the hook input' "$passing" "$repo" 'git push' 2
run_cwd 'cwd: a passing session repo from the hook input' "$repo" "$passing" 'git push' 0
run_cwd 'cwd: a relative cd starts in the hook input directory' "$repo" "$repo/sub" 'cd .. && git push' 2
run_cwd 'cwd: a relative -C starts in the hook input directory' "$repo" "$repo/sub" 'git -C .. push' 2
run_cwd 'cwd: a relative cd from the hook input directory to a repo with no gate' "$gated" "$repo/sub" 'cd ../../nogate && git push' 0
run_cwd 'cwd: an empty hook input directory falls back to the process directory' "$repo" '' 'git push' 2
run_cwd 'cwd: a missing hook input directory falls back to the process directory' "$repo" "$base/missing" 'git push' 2

# A cd whose result the gate cannot know is no target. cd link/.. goes to the parent of
# the link, and cd -P link/.. to the parent of its target. A cd to x/.. fails when x is
# missing, and bash then stays in the old directory. The gate gives up on a cd path
# that holds a part like x/.. and on a cd that follows one.
run_case 'target: cd -P symlink/..' "cd -P \"$base/x/linksub/..\" && git push" 2
run_case 'target: cd -P symlink, then cd ..' "cd -P \"$base/x/linksub\" && cd .. && git push" 2
run_case 'target: cd symlink/.. (logical)' "cd \"$base/x/linksub/..\" && git push" 2
run_case 'target: cd symlink, then cd ..' "cd \"$base/x/linksub\" && cd .. && git push" 2
run_case 'target: cd -P a plain dir still counts' "cd -P \"$other\" && git push" 0
run_case 'target: cd a symlink to a repo with no gate still counts' "cd \"$base/x/linkother\" && git push" 0
run_case 'target: -C a symlink then .. is physical, as in git' "git -C \"$base/x/linksub/..\" push" 2
run_case 'path: cd into a missing dir and back, push after ;' "cd \"$base/missing/..\"; git push" 2
run_case 'path: cd with a .. in the middle, push after ;' "cd \"$other/sub/../..\"; git push" 2
run_case 'path: cd, then cd .. out of it' "cd \"$other\" && cd .. && git push" 2
# A cd that follows a cd in an && list runs only when the first one worked.
run_case 'scope: a cd after a cd that may fail, push after ;' "cd /nonexistent && cd \"$other\"; git push" 2
run_case 'scope: a cd after a cd that may fail, a step, push after ;' "cd /nonexistent && cd \"$other\" ; echo x ; git push" 2
run_case 'scope: a cd after a cd, push on the next line' "cd /nonexistent && cd \"$other\"${nl}git push" 2
run_case 'scope: a cd after a cd, push in the same list' "cd /nonexistent && cd \"$other\" && git push" 0
run_case 'scope: ; between two cds: the second runs on its own' "cd /nonexistent; cd \"$other\"; git push" 0
# Commands that may change the directory in a way the gate cannot follow.
run_case 'scope: dot' "cd \"$other\"; . ./x.sh; git push" 2
run_case 'scope: popd' "cd \"$other\"; popd; git push" 2
run_case 'scope: exec' "cd \"$other\"; exec true; git push" 2
run_case 'scope: pushd after a cd' "cd \"$other\" && pushd \"$repo\" && git push" 2
run_case 'scope: pushd, output dropped, push after ;' "cd \"$other\" && pushd \"$repo\" >/dev/null; git push" 2
# A push that runs after another step may find the target changed: a directory with no
# repo can become a worktree or a link to this repo. Only a push that runs first, or
# after a cd, may pass on "no repo".
run_case 'target: a no-repo dir that an earlier step makes a worktree' "git worktree add -q \"$plain\" -b x && git -C \"$plain\" push" 2
run_case 'target: a no-repo dir that an earlier step makes a worktree, cd' "git worktree add -q \"$plain\" -b x && cd \"$plain\" && git push" 2
run_case 'target: a no-repo dir that an earlier step links to this repo' "rmdir \"$plain\" && ln -s \"$repo\" \"$plain\" && git -C \"$plain\" push" 2
run_case 'target: a no-repo dir after another step and ;' "echo x; git -C \"$plain\" push" 2
run_case 'target: a no-repo dir after a step in a subshell' "(echo x); git -C \"$plain\" push" 2
run_case 'target: a no-repo dir after a step in a pipe' "echo x | cat; git -C \"$plain\" push" 2
run_case 'target: a no-repo dir, push first' "git -C \"$plain\" push && echo x" 0
run_case 'target: a no-repo dir after a cd only' "cd \"$plain\" && git push" 0
run_case 'target: a no-repo dir after cds only' "cd /tmp; cd \"$plain\"; git push" 0
run_case 'target: a repo with no gate after another step' "echo x; git -C \"$other\" push" 0
# Global options of git that leave the target as it is.
run_case 'target: --no-pager before -C' "git --no-pager -C \"$other\" push" 0
run_case 'target: -P before -C' "git -P -C \"$other\" push" 0
run_case 'target: --paginate before -C' "git --paginate -C \"$other\" push" 0
run_case 'target: --no-optional-locks after -C' "git -C \"$other\" --no-optional-locks push" 0
# Every gh stack subcommand that pushes is placed.
run_case 'target: gh stack sync' "cd \"$other\" && gh stack sync" 0
run_case 'target: gh stack merge' "cd \"$other\" && gh stack merge --yes --squash" 0
# A target with a space in its path, where the verify passes: a pass shows the gate ran
# there. The session repo fails, so a fallback to it would deny.
run_case 'target: a path with a space, verify passes, -C' "git -C \"$spaced_ok\" push" 0
run_case 'target: a path with a space, verify passes, cd' "cd \"$spaced_ok\" && git push" 0
run_case 'target: a path with a space, verify passes, single quotes' "git -C '$spaced_ok' push" 0
run_cwd 'target: a red target, a green session' "$passing" "$passing" "git -C \"$spaced\" push" 2
# The session repo is "this repo" only when it holds the gate, as for any other target.
run_msg 'session without the gate: a plain push passes' "$nogate" 'git push' 0 ''
run_msg 'session without the gate: a dry run passes' "$nogate" 'git push --dry-run origin main' 0 ''
run_msg 'session without the gate: cd . passes' "$nogate" 'cd . && git push' 0 ''
run_msg 'session without the gate: an unknown target passes' "$nogate" 'git push $(echo origin)' 0 ''
run_msg 'session without the gate: gh stack passes' "$nogate" 'gh stack submit' 0 ''
run_msg 'session without the gate: a repo with the gate is still gated' "$nogate" "git -C \"$gated\" push" 2 ''
run_msg 'session without the gate: a repo with a passing gate passes' "$nogate" "git -C \"$passing\" push" 0 ''
run_msg 'session without the gate: a missing directory passes' "$nogate" 'git -C /nonexistent push' 0 ''
run_msg 'session without the gate: a no-repo dir after another step passes' "$nogate" "echo x; git -C \"$plain\" push" 0 ''
run_msg 'session with the gate: an unknown target is gated' "$repo" 'git push $(echo origin)' 2 ''
# A tool directory that drifted into a repo with no gate does not hide a push of the
# project: an unknown target runs make verify in the repo of the project, when it has the gate.
run_env 'drifted: an unknown target is gated in the project repo' "$nogate" "CLAUDE_PROJECT_DIR=$repo" 'git push $(echo origin)' 2
run_env 'drifted: the deny text names the project repo' "$nogate" "CLAUDE_PROJECT_DIR=$repo" 'git push $(echo origin)' 2 '' 'make verify failed in '
run_env 'drifted: an eval is gated in the project repo' "$nogate" "CLAUDE_PROJECT_DIR=$repo" "eval 'git push'" 2
run_env 'drifted: a missing directory is gated in the project repo' "$nogate" "CLAUDE_PROJECT_DIR=$repo" 'git -C /nonexistent push' 2
run_env 'drifted: a plain push from the directory has nothing to check' "$nogate" "CLAUDE_PROJECT_DIR=$repo" 'git push' 0
run_env 'drifted: a push in a repo with no gate has nothing to check' "$nogate" "CLAUDE_PROJECT_DIR=$repo" "cd \"$other\" && git push --dry-run origin main" 0
run_env 'drifted: -C a worktree of the project repo' "$nogate" "CLAUDE_PROJECT_DIR=$repo" "git -C \"$wt\" push" 2
run_env 'drifted: -C a worktree of the project repo with a passing verify' "$nogate" "CLAUDE_PROJECT_DIR=$repo" "git -C \"$wtok\" push" 0
run_cwd 'drifted: the process directory holds the gate, an eval' "$repo" "$nogate" "eval 'git push'" 2
run_cwd 'drifted: the process directory holds the gate, a plain push from here' "$repo" "$nogate" 'git push' 0
# The home repo is the repo of the tool directory when it holds the gate, and not the
# repo of the process directory or of CLAUDE_PROJECT_DIR. The orchestrator runs with
# CLAUDE_PROJECT_DIR in one checkout and its tool directory in a worktree.
run_cwd 'home: the tool directory repo (red), the process directory green' "$passing" "$repo" 'git push $(echo origin)' 2
run_cwd 'home: the tool directory repo (green), the process directory red' "$repo" "$passing" 'git push $(echo origin)' 0
run_env 'home: CLAUDE_PROJECT_DIR green, the tool directory red' "$plain" "CLAUDE_PROJECT_DIR=$passing" 'git push $(echo origin)' 2 "$repo"
run_env 'home: CLAUDE_PROJECT_DIR red, the tool directory green' "$plain" "CLAUDE_PROJECT_DIR=$repo" 'git push $(echo origin)' 0 "$passing"
# Settings in the environment of the gate move every repo. The gate gives up on a path.
run_env 'env process: GIT_DIR' "$repo" "GIT_DIR=$repo/.git" "git -C \"$passing\" push" 2
run_env 'env process: GIT_COMMON_DIR' "$repo" "GIT_COMMON_DIR=$repo/.git" "git -C \"$passing\" push" 2
run_env 'env process: CDPATH' "$repo" "CDPATH=$base" 'cd passing && git push' 2
run_env 'env process: GIT_DIR, a command that is no push' "$repo" "GIT_DIR=$repo/.git" 'ls' 0
run_case 'env: export GIT_COMMON_DIR' "export GIT_COMMON_DIR=\"$repo/.git\"; git -C \"$passing\" push" 2
run_case 'env: export GIT_WORK_TREE' "export GIT_WORK_TREE=\"$repo\"; git -C \"$other\" push" 2
run_cwd 'env: export CDPATH, a relative cd resolves through it' "$repo" "$base" "export CDPATH=\"$base/cdp\"; cd other && git push" 2
# When an awk script fails, the gate reads the command as it came: a deny, never a pass.
run_gate 'awk missing: a plain push is gated' "$gate_no_awk" 'git push' 2
run_gate 'awk missing: a push in another repo is gated in the session repo' "$gate_no_awk" "git -C \"$other\" push" 2
run_gate 'awk missing: a heredoc body stays in the match' "$gate_no_awk" "cat <<'EOF'${nl}git push${nl}EOF" 2
run_gate 'awk missing: a command that is no push passes' "$gate_no_awk" 'ls' 0
# A hook cwd outside any repo: the gate falls back to the repo of the project (the
# process directory, or CLAUDE_PROJECT_DIR when it is set), never to a pass.
run_cwd 'cwd: no repo at the hook input, -C this repo' "$repo" "$plain" "git -C \"$repo\" push" 2
run_cwd 'cwd: no repo at the hook input, cd this repo' "$repo" "$plain" "cd \"$repo\" && git push" 2
run_cwd 'cwd: no repo at the hook input, -C a worktree of this repo' "$repo" "$plain" "git -C \"$wt\" push" 2
run_cwd 'cwd: no repo at the hook input, -C a worktree with a passing verify' "$repo" "$plain" "git -C \"$wtok\" push" 0
run_cwd 'cwd: no repo at the hook input, -C a repo with no gate' "$repo" "$plain" "git -C \"$other\" push" 0
run_cwd 'cwd: no repo at the hook input, a bare push has no target' "$repo" "$plain" 'git push' 0
run_env 'cwd: no repo anywhere, CLAUDE_PROJECT_DIR names the repo' "$plain" "CLAUDE_PROJECT_DIR=$repo" "git -C \"$repo\" push" 2 "$plain"
run_env 'cwd: no repo anywhere, CLAUDE_PROJECT_DIR names a worktree' "$plain" "CLAUDE_PROJECT_DIR=$repo" "cd \"$wt\" && git push" 2 "$plain"
run_env 'cwd: no repo anywhere, CLAUDE_PROJECT_DIR names a repo with no gate' "$plain" "CLAUDE_PROJECT_DIR=$other" "git -C \"$gated\" push" 2 "$plain"
run_env 'cwd: no repo anywhere, CLAUDE_PROJECT_DIR gates an unknown target' "$plain" "CLAUDE_PROJECT_DIR=$repo" 'git push $(echo origin)' 2 "$plain"
run_cwd 'cwd: no repo anywhere, no project dir: nothing to gate' "$plain" "$plain" 'git push $(echo origin)' 0
run_cwd 'cwd: no repo anywhere, no project dir, -C a repo with the gate' "$plain" "$plain" "git -C \"$gated\" push" 2
# Copilot sends toolName and toolArgs, and report_progress. Claude Code sends tool_name.
json_str '{"command":"git push"}'
copilot_args=$REPLY
run_json 'copilot: a push in string toolArgs' "{\"toolName\":\"bash\",\"cwd\":\"$repo\",\"toolArgs\":$copilot_args}" "$repo" 2
run_json 'copilot: a push in object toolArgs' '{"toolName":"bash","toolArgs":{"command":"git push"}}' "$repo" 2
run_json 'copilot: a command that is no push' '{"toolName":"bash","toolArgs":{"command":"ls"}}' "$repo" 0
run_json 'copilot: another tool passes' '{"toolName":"view","toolArgs":{"path":"x"}}' "$repo" 0
run_json 'copilot: report_progress is gated' '{"toolName":"report_progress","toolArgs":"{}"}' "$repo" 2
run_json 'copilot: report_progress passes on a green verify' '{"toolName":"report_progress","toolArgs":"{}"}' "$passing" 0
run_json 'copilot: report_progress, no repo at the cwd, falls back' "{\"toolName\":\"report_progress\",\"toolArgs\":\"{}\",\"cwd\":\"$plain\"}" "$repo" 2
run_json 'copilot: report_progress, no repo anywhere, CLAUDE_PROJECT_DIR names the repo' "{\"toolName\":\"report_progress\",\"toolArgs\":\"{}\",\"cwd\":\"$plain\"}" "$plain" 2 "CLAUDE_PROJECT_DIR=$repo"
run_json 'copilot: report_progress, no repo anywhere, nothing to gate' "{\"toolName\":\"report_progress\",\"toolArgs\":\"{}\",\"cwd\":\"$plain\"}" "$plain" 0
run_json 'claude: another tool passes' '{"tool_name":"Edit","tool_input":{"file_path":"x"}}' "$repo" 0

# The deny text names the real cause.
run_msg 'deny text: main names no-commit-to-branch' "$mainrepo" 'git push origin main' 2 'no-commit-to-branch' 'stage the fixer'
run_msg 'deny text: main says how to go on' "$mainrepo" 'git push' 2 'git switch -c'
run_msg 'deny text: another repo on main' "$repo" "git -C \"$mainrepo\" push" 2 'no-commit-to-branch' 'stage the fixer'
run_msg 'deny text: a failed verify keeps the generic text' "$repo" 'git push' 2 'make verify failed' 'no-commit-to-branch'
run_msg 'deny text: names the repo that failed' "$repo" "git -C \"$gated\" push" 2 '/gated'

run_msg 'deny text: main and a lint failure keep the generic text' "$mainlint" 'git push' 2 'Fix the cause' 'This is not a lint error'
run_msg 'deny text: main with a lint failure names the hook output' "$mainlint" 'git push' 2 'biome check'

# Stop mode blocks the end of a session with a red verify. It names the same causes.
run_stop 'stop: a red verify blocks' "$gated" 'make verify failed'
run_stop 'stop: main names no-commit-to-branch' "$mainrepo" 'no-commit-to-branch'
run_stop 'stop: main and a lint failure keep the generic text' "$mainlint" 'Fix the cause'
run_stop 'stop: no repo at the hook input falls back to the process directory' "$gated" 'make verify failed' "{\"cwd\":\"$plain\"}"

run_all

# The serial part. A case here runs the gate twice, or reads what the gate leaves behind.
# A filter that names none of its groups skips it.
if ! wanted 'cache: temp files: one list:'; then exit "$failed"; fi
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failed=1
}

# The stamp cache: a pass is cached per tree state, in the repo that ran make verify.
cnt="$base/count"
: >"$cnt"
runs() { wc -l <"$cnt" | tr -d ' '; }
mkrepo "$base/cached" 0 gate
printf 'verify:\n\t@echo x >>%s\n' "$cnt" >"$base/cached/Makefile"
git -C "$base/cached" add -A
git_t -C "$base/cached" commit -q -m init
now "$repo" "git -C \"$base/cached\" push"
if [ "$status" -eq 0 ] && [ "$(runs)" = 1 ]; then pass 'cache: the first push runs verify'; else fail "cache: the first push runs verify (exit $status, runs $(runs))"; fi
now "$repo" "git -C \"$base/cached\" push"
if [ "$status" -eq 0 ] && [ "$(runs)" = 1 ]; then pass 'cache: the same state runs verify once'; else fail "cache: the same state runs verify once (exit $status, runs $(runs))"; fi
if [ -f "$base/cached/.git/verify-gate.stamp" ] && [ ! -e "$repo/.git/verify-gate.stamp" ]; then
  pass 'cache: the stamp is in the repo that ran verify'
else
  fail 'cache: the stamp is not in the repo that ran verify'
fi
printf 'verify:\n\t@echo x >>%s\n\t@exit 1\n' "$cnt" >"$base/cached/Makefile"
now "$repo" "git -C \"$base/cached\" push"
if [ "$status" -eq 2 ] && [ "$(runs)" = 2 ]; then pass 'cache: a changed tree runs verify again'; else fail "cache: a changed tree runs verify again (exit $status, runs $(runs))"; fi
printf 'verify:\n\t@echo x >>%s\n' "$cnt" >"$base/cached/Makefile"
now "$repo" "git -C \"$base/cached\" push"
if [ "$status" -eq 0 ] && [ "$(runs)" = 2 ]; then pass 'cache: a tree back at a passed state is not run again'; else fail "cache: a tree back at a passed state is not run again (exit $status, runs $(runs))"; fi
printf 'stale\n' >"$base/cached/.git/verify-gate.stamp"
now "$repo" "git -C \"$base/cached\" push"
if [ "$status" -eq 0 ] && [ "$(runs)" = 3 ]; then pass 'cache: a stale stamp runs verify again'; else fail "cache: a stale stamp runs verify again (exit $status, runs $(runs))"; fi

# The gate leaves no temp file behind: not on a pass, a deny, a push with a target scan
# or a stop. A pass must run make verify to make its log: $passing already has a stamp
# from the cases above and exits on the cache, so a fresh repo makes the first run.
gate_tmp() { # command dir
  mk_input "" "$1"
  (cd "$2" && printf '%s' "$REPLY" | env TMPDIR="$base/tmp" "$gate" pre-tool >/dev/null 2>&1)
}
mkrepo "$base/fresh" 0 gate
gate_tmp "git -C \"$other\" push" "$repo"
gate_tmp "git -C \"$gated\" push" "$repo"
gate_tmp "git -C \"$base/fresh\" push" "$repo"
if [ ! -f "$base/fresh/.git/verify-gate.stamp" ]; then fail 'temp files: the first pass in a fresh repo ran no verify'; fi
# The log of make verify is made under TMPDIR (macOS mktemp ignores TMPDIR with no template,
# and then a leak is invisible here). This verify fails unless the log is there.
mkrepo "$base/fresh_tmp" 0 gate
printf 'verify:\n\t@ls "$$TMPDIR"/verify-gate-log.* >/dev/null\n' >"$base/fresh_tmp/Makefile"
gate_tmp "git -C \"$base/fresh_tmp\" push" "$repo"
if [ ! -f "$base/fresh_tmp/.git/verify-gate.stamp" ]; then fail 'temp files: the log of make verify is not under TMPDIR'; fi
gate_tmp "git -C \"$passing\" push" "$repo"
gate_tmp 'git push' "$repo"
gate_tmp "cat > f <<'EOF'${nl}git push${nl}EOF" "$repo"
if [ -z "$(ls -A "$base/tmp")" ]; then pass 'temp files: none left behind'; else fail "temp files: left behind: $(ls -A "$base/tmp")"; fi

# One list of the gh stack subcommands that push. The shell holds it. The awk gets it.
if [ "$(grep -c "^gh_stack_push='push|submit|sync|merge|link'$" "$here/verify-gate.sh")" = 1 ] \
  && ! grep -q 'submit' "$here/verify-gate-target.awk"; then
  pass 'one list: the gh stack subcommands that push are defined once'
else
  fail 'one list: the gh stack subcommands that push are defined twice or not in verify-gate.sh'
fi

exit "$failed"
