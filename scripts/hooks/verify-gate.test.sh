#!/usr/bin/env bash
# Test scripts/hooks/verify-gate.sh in pre-tool mode.
# The temp repo has a `verify` target that always fails. A gated command is
# denied (exit 2). A command the gate ignores passes (exit 0).
# shellcheck disable=SC2016 # the cases are literal command text; nothing should expand
set -u

here="$(cd "$(dirname "$0")" && pwd -P)"
gate="$here/verify-gate.sh"

repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
git -C "$repo" init -q
printf 'verify:\n\t@exit 1\n' >"$repo/Makefile"

failed=0

# run_case name command expected_exit
run_case() {
  local name=$1
  local command=$2
  local expect=$3
  local status
  jq -cn --arg c "$command" '{tool_name: "Bash", tool_input: {command: $c}}' |
    (cd "$repo" && "$gate" pre-tool) >/dev/null 2>&1
  status=$?
  if [ "$status" -ne "$expect" ]; then
    printf 'FAIL %s: expected exit %s, got %s\n' "$name" "$expect" "$status"
    failed=1
    return
  fi
  printf 'ok   %s (exit %s)\n' "$name" "$status"
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

exit "$failed"
