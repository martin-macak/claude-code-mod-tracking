#!/usr/bin/env bash
# Tests for install-local-watch.sh. They run in a scratch git repo with fake install
# and uninstall commands, so they need no claude. Run: make test-scripts.
set -u

here="$(cd "$(dirname "$0")" && pwd -P)"
watch="$here/install-local-watch.sh"
tmp="$(mktemp -d)"
tmp="$(cd "$tmp" && pwd -P)"
root="$tmp/repo"
holders=()
fails=0

cleanup() {
	for p in "${holders[@]}"; do kill "$p" 2>/dev/null; done
	[ -f "$root/.git/install-local-watch.pid" ] && kill "$(cat "$root/.git/install-local-watch.pid")" 2>/dev/null
	rm -rf "$tmp"
}
trap cleanup EXIT

copy="$root/.claude/skills/artifact-tracking-dev"
export WATCH_INTERVAL=0.2 WATCH_IDLE_ROUNDS=2
export WATCH_INSTALL_CMD="mkdir -p '$copy/.claude-plugin' && touch '$copy/.claude-plugin/plugin.json' && echo x >>'$tmp/installs'"
export WATCH_UNINSTALL_CMD="rm -rf '$copy'"

check() { # check <name> <command...>
	local name=$1
	shift
	if "$@"; then echo "ok   $name"; else echo "FAIL $name"; fails=$((fails + 1)); fi
}
installs() { [ -f "$tmp/installs" ] && wc -l <"$tmp/installs" | tr -d ' ' || echo 0; }
wait_for() { # wait_for <command...>: up to 10 s
	local _
	for _ in $(seq 50); do "$@" && return 0; sleep 0.2; done
	return 1
}
hold() { # hold <dir>: a process with its cwd in <dir>, like a shell or a claude
	(cd "$1" && exec sleep 300) &
	holders+=($!)
}
watcher_pid() { cat "$root/.git/install-local-watch.pid" 2>/dev/null; }
watcher_up() { [ -n "$(watcher_pid)" ] && kill -0 "$(watcher_pid)" 2>/dev/null; }
watcher_down() { ! watcher_up; }
no_copy() { [ ! -e "$copy" ]; }
installs_are() { [ "$(installs)" = "$1" ]; }

git init -q "$root"
cp "$here/../../.gitignore" "$root/.gitignore"
mkdir -p "$root/plugins/artifact-tracking"
echo a >"$root/plugins/artifact-tracking/file"
git -C "$root" add -A
git -C "$root" -c user.name=t -c user.email=t@t commit -qm init

# install: copies when missing, skips when fresh, copies again after an edit.
"$watch" install "$root"
check "install copies a missing copy" installs_are 1
"$watch" install "$root"
check "install skips a fresh copy" installs_are 1
sleep 1.1
echo b >"$root/plugins/artifact-tracking/file"
"$watch" install "$root"
check "install copies again after an edit" installs_are 2

# start: one watcher, which copies on edit while someone is in the checkout.
hold "$root"
"$watch" start "$root"
check "start runs a watcher" wait_for watcher_up
first="$(watcher_pid)"
"$watch" start "$root"
check "a second start keeps the one watcher" [ "$(watcher_pid)" = "$first" ]
sleep 1.1
echo c >"$root/plugins/artifact-tracking/file"
check "the watcher copies again after an edit" wait_for installs_are 3

# leave: the last process leaves, the copy goes, the watcher exits.
kill "${holders[0]}"
check "leaving removes the copy" wait_for no_copy
check "the watcher exits after leaving" wait_for watcher_down

# A process in a worktree nested in the checkout does not keep the copy.
git -C "$root" worktree add -q "$root/.claude/worktrees/x" 2>/dev/null
"$watch" install "$root"
hold "$root/.claude/worktrees/x"
"$watch" start "$root"
check "a nested worktree does not count as the checkout" wait_for no_copy
check "the watcher exits with only a nested worktree in use" wait_for watcher_down

# The copy stays ignored with no line in .git/info/exclude: uninstall-local in one
# worktree removes that shared line while another worktree still has its copy.
mkdir -p "$copy/.claude-plugin" && touch "$copy/.claude-plugin/plugin.json"
check ".gitignore ignores the copy" git -C "$root" check-ignore -q "$copy/.claude-plugin/plugin.json"

[ "$fails" -eq 0 ] || { echo "$fails test(s) failed"; exit 1; }
echo "all install-local-watch tests passed"
