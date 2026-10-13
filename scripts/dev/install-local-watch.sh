#!/usr/bin/env bash
# Keep the install-local copy of the mod in step with one checkout, with no prompt
# and no agent in the loop. .envrc calls it; direnv has no leave hook, so a
# background watcher does the leave part.
#
#   install-local-watch.sh install <root>  Copy now when the copy is missing or stale.
#   install-local-watch.sh start <root>    Start the watcher unless one runs already.
#   install-local-watch.sh run <root>      The watcher loop (start runs it detached).
#
# The watcher polls every WATCH_INTERVAL seconds:
# - A file under the plugin is newer than the copy: copy again.
# - No process of this user has its cwd in the checkout for WATCH_IDLE_ROUNDS polls
#   in a row: run uninstall-local and exit. A shell, a claude or its tools all count,
#   so a claude that still runs here keeps the copy. A process in a worktree nested
#   under the checkout (.claude/worktrees/...) counts for that worktree only.
# - The checkout is gone: exit.
#
# Tests set WATCH_INSTALL_CMD and WATCH_UNINSTALL_CMD in place of the make targets.
set -u

PLUGIN_DIR=plugins/artifact-tracking
STAMP=.claude/skills/artifact-tracking-dev/.claude-plugin/plugin.json
INTERVAL="${WATCH_INTERVAL:-3}"
IDLE_ROUNDS="${WATCH_IDLE_ROUNDS:-3}"

die() { echo "install-local-watch: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: $0 install|start|run <root>"
mode=$1
root="$(cd "$2" 2>/dev/null && pwd -P)" || die "no such folder: $2"
git_dir="$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null)" || die "not a git checkout: $root"
pid_file="$git_dir/install-local-watch.pid"
lock_dir="$git_dir/install-local.lock"

install_cmd() {
	if [ -n "${WATCH_INSTALL_CMD:-}" ]; then sh -c "$WATCH_INSTALL_CMD"; else make -s -C "$root" install-local >/dev/null; fi
}
uninstall_cmd() {
	if [ -n "${WATCH_UNINSTALL_CMD:-}" ]; then sh -c "$WATCH_UNINSTALL_CMD"; else make -s -C "$root" uninstall-local >/dev/null; fi
}

# Stale: the copy is missing, or a file or folder under the plugin is newer.
# A folder counts, so a deleted file also makes the copy stale.
stale() {
	[ ! -f "$root/$STAMP" ] || [ -n "$(find "$root/$PLUGIN_DIR" -newer "$root/$STAMP" -print -quit 2>/dev/null)" ]
}

# One copy at a time: .envrc and the watcher may both try. mkdir is atomic.
locked() {
	local tries=0
	until mkdir "$lock_dir" 2>/dev/null; do
		tries=$((tries + 1))
		[ "$tries" -lt 120 ] || { rm -rf "$lock_dir"; continue; }
		sleep 0.5
	done
	"$@"
	local rc=$?
	rmdir "$lock_dir" 2>/dev/null
	return "$rc"
}

copy_if_stale() { if stale; then install_cmd; fi; }

# The cwd of every process of this user, one per line.
cwds() {
	if [ -r /proc/self/cwd ]; then
		local p
		for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null; done
	else
		lsof -a -d cwd -u "$(id -u)" -Fn 2>/dev/null | sed -n 's/^n//p'
	fi
}

# Other worktrees inside this checkout. Their processes are not ours.
nested_roots() {
	git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' |
		while IFS= read -r wt; do
			wt="$(cd "$wt" 2>/dev/null && pwd -P)" || continue
			case "$wt" in "$root"/*) echo "$wt" ;; esac
		done
}

in_use() {
	local nested path n
	nested="$(nested_roots)"
	while IFS= read -r path; do
		case "$path" in "$root" | "$root"/*) ;; *) continue ;; esac
		if [ -n "$nested" ]; then
			while IFS= read -r n; do
				case "$path" in "$n" | "$n"/*) continue 2 ;; esac
			done <<<"$nested"
		fi
		return 0
	done < <(cwds)
	return 1
}

running() {
	local pid
	pid="$(cat "$pid_file" 2>/dev/null)" || return 1
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

run() {
	# Do not count as a process in the checkout.
	cd / || exit 1
	echo $$ >"$pid_file"
	trap 'rm -f "$pid_file"' EXIT
	trap '' HUP INT
	local idle=0
	while [ -d "$root/$PLUGIN_DIR" ]; do
		if in_use; then
			idle=0
			# Copy again only when a copy exists. A missing copy means someone ran
			# uninstall-local by hand; the next cd puts it back.
			if [ -f "$root/$STAMP" ]; then locked copy_if_stale; fi
		else
			idle=$((idle + 1))
			if [ "$idle" -ge "$IDLE_ROUNDS" ]; then
				locked uninstall_cmd
				# A shell that entered meanwhile saw this watcher and did not start one.
				in_use || exit 0
				locked copy_if_stale
				idle=0
			fi
		fi
		sleep "$INTERVAL"
	done
}

case "$mode" in
install) locked copy_if_stale ;;
start)
	running && exit 0
	# nohup and the async job ignore HUP and INT, so closing a terminal or Ctrl-C at
	# the prompt does not stop the watcher. No fd stays open, so direnv does not wait.
	nohup "$0" run "$root" </dev/null >>"$git_dir/install-local-watch.log" 2>&1 &
	;;
run) run ;;
*) die "unknown mode: $mode" ;;
esac
