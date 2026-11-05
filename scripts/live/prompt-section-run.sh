#!/usr/bin/env bash
# Live run of the prompt-section runbook (issue #91): do the prompt sections of the mod reach the model?
# Runbook: https://github.com/martin-macak/claude-code-mod-tracking/issues/91 (first comment). Design: KB
# docs/knowledge-base/claude-code-mod-architecture/lifecycle-manager.md section 5.7, "Run:" paragraph.
#
# Usage: prompt-section-run.sh [all|guard-only]
#   all         guard check, arms A-D (six messages), arms B and C (compact plan), summary, redaction.
#   guard-only  the guard check only.
# Env:
#   W      work folder (default: a new temp folder).
#   CLONE  the checkout that holds plugins/artifact-tracking (default: this repo).
# Sign-in: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or a stored login. The script never prints a token.
# Exit codes: 0 done, 2 bad setup, 3 the guard cc-plugin-sec-default is seated (precondition failed), 4 claude failed,
#             5 redaction left a secret in the upload folder (the folder is deleted), 6 an arm failed.
# Output: $W/out (raw, may hold paths), $W/paste (redacted, safe to upload), $W/out/summary.txt.
# The processes endedTtlMs addendum (issue comment) needs the /track pane. It cannot run headless, so the
# summary lists it as not run.
set -euo pipefail

MODE=${1:-all}
case "$MODE" in all | guard-only) ;; *)
	echo "usage: $0 [all|guard-only]" >&2
	exit 2
	;;
esac

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLONE=${CLONE:-$(cd "$HERE/../.." && pwd)}
FAILED_ARMS=()
W=${W:-$(mktemp -d "${TMPDIR:-/tmp}/l91.XXXXXX")}
PLUGIN="$CLONE/plugins/artifact-tracking"
OUT="$W/out"
PASTE="$W/paste"
SUMMARY="$OUT/summary.txt"

# A Claude Code session leaks CLAUDE_CODE_* variables into the runs. Drop them, but keep the sign-in token.
for v in $(env | sed -n -E 's/^((CLAUDECODE|CLAUDE_CODE_[A-Z0-9_]*))=.*/\1/p'); do
	[ "$v" = CLAUDE_CODE_OAUTH_TOKEN ] || unset "$v"
done

for tool in claude jq git awk paste column sed grep; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "missing tool: $tool" >&2
		exit 2
	}
done
[ -f "$PLUGIN/.claude-plugin/plugin.json" ] || {
	echo "no mod at $PLUGIN" >&2
	exit 2
}

mkdir -p "$W/cfg" "$OUT" "$W/proj"
git -C "$W/proj" init -q 2>/dev/null

say() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }

# --- redaction -------------------------------------------------------------------------------------------------
scrub() {
	sed -E "s/sk-ant-[A-Za-z0-9_-]+/[REDACTED-KEY]/g; s#${HOME}#~#g; s#/Users/[^/\" ]+#/Users/USER#g; s#/home/[^/\" ]+#/home/USER#g; s#-(Users|home)-[A-Za-z0-9._]+#-\1-USER#g; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/EMAIL/g"
}

redact() {
	rm -rf "${PASTE:?}"
	mkdir -p "$PASTE"
	local f
	# Stream: keep counts, drop lists and paths from the init messages.
	for f in "$OUT"/*.jsonl; do
		[ -f "$f" ] || continue
		jq -c 'if .type == "system" and .subtype == "init"
         then (.tools |= length | .mcp_servers |= length
               | del(.slash_commands, .skills, .agents, .memory_paths, .cwd, .original_cwd,
                     .messaging_socket_path, .additional_directories))
         else . end' "$f" | scrub >"$PASTE/$(basename "$f")"
	done
	# Debug logs: only the lines that matter. The full logs stay on the machine.
	for f in "$OUT"/*.log; do
		[ -f "$f" ] || continue
		{ grep -E 'artifact-tracking|prompt\.compose|seated|bypassed by|sec-default@builtin loaded|MDM settings|compact' "$f" || true; } |
			scrub >"$PASTE/$(basename "$f" .log).extract.txt"
	done
	for f in "$OUT"/*.tsv "$OUT"/*.json "$OUT"/*.stderr "$OUT"/*.txt; do
		[ -f "$f" ] || continue
		# shellcheck disable=SC2094 # reads $OUT, writes $PASTE: two different folders
		scrub <"$f" >"$PASTE/$(basename "$f")"
	done
	# The upload folder must hold no key and no email. Delete it if it does.
	local leaks
	leaks=$(grep -R -n -i -E 'sk-ant-[A-Za-z0-9_-]{8,}|[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}' "$PASTE" || true)
	if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && grep -R -q -F -f <(printf '%s\n' "$CLAUDE_CODE_OAUTH_TOKEN") "$PASTE"; then
		leaks="${leaks}the sign-in token is in the upload folder"
	fi
	if [ -n "${ANTHROPIC_API_KEY:-}" ] && grep -R -q -F -f <(printf '%s\n' "$ANTHROPIC_API_KEY") "$PASTE"; then
		leaks="${leaks}the API key is in the upload folder"
	fi
	if [ -n "$leaks" ]; then
		rm -rf "${PASTE:?}"
		echo "REDACTION FAILED: deleted $PASTE. Files with a hit:" >&2
		printf '%s\n' "$leaks" | cut -d: -f1 | sort -u >&2
		return 5
	fi
	echo "redacted copy: $PASTE"
}

# The job summary gets the redacted text only.
publish_summary() {
	[ -f "$SUMMARY" ] || return 0
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		{
			echo '## Prompt-section live run (issue #91)'
			echo '```text'
			scrub <"$SUMMARY"
			echo '```'
		} >>"$GITHUB_STEP_SUMMARY"
	fi
}

finish() {
	local rc=$?
	trap - EXIT
	set +e
	publish_summary
	redact || rc=5
	exit "$rc"
}
trap finish EXIT

# --- guard check (runbook 1.3, 1.4, 1.6) -----------------------------------------------------------------------
guard_check() {
	say "## managed settings (must not exist)"
	# shellcheck disable=SC2012 # a plain listing of three fixed paths
	ls -l "/Library/Managed Preferences/com.anthropic.claudecode.plist" \
		"/Library/Managed Preferences/${USER:-nobody}/com.anthropic.claudecode.plist" \
		"/Library/Application Support/ClaudeCode" \
		/etc/claude-code/managed-settings.json /etc/claude-code/managed-settings.d 2>&1 | sed 's/^/  /' | tee -a "$SUMMARY" || true

	say ""
	say "## sign-in"
	if [ -n "${ANTHROPIC_API_KEY:-}" ]; then say "ANTHROPIC_API_KEY is set"; fi
	if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then say "CLAUDE_CODE_OAUTH_TOKEN is set"; fi
	claude auth status 2>&1 | sed -E 's/"(email|orgId|orgName)": *"[^"]*"/"\1": "<redacted>"/' | tee -a "$SUMMARY" || true

	say ""
	say "## guard check (one request)"
	mkdir -p "$W/cfg/check"
	rm -f "${OUT:?}/guard-check.log"
	local rc=0
	(cd "$W/proj" && CLAUDE_TRACKER_CONFIG_DIR="$W/cfg/check" claude -p --model haiku \
		--setting-sources project --plugin-dir "$PLUGIN" \
		--output-format stream-json --verbose \
		--debug-file "$OUT/guard-check.log" "Reply with OK." >"$OUT/guard-check.jsonl" 2>"$OUT/guard-check.stderr") || rc=$?
	if [ "$rc" -ne 0 ]; then
		say "claude failed with exit $rc. stderr:"
		scrub <"$OUT/guard-check.stderr" | head -20 | tee -a "$SUMMARY"
		exit 4
	fi
	local seated bypassed secdef
	seated=$(grep -c 'sec-default@builtin seated' "$OUT/guard-check.log" || true)
	bypassed=$(grep -c 'bypassed by' "$OUT/guard-check.log" || true)
	secdef=$(grep -c 'sec-default' "$OUT/guard-check.log" || true)
	say "seated lines (must be 0):   $seated"
	say "bypassed lines (must be 0): $bypassed"
	say "sec-default lines (diagnostic): $secdef"
	grep -n 'artifact-tracking@inline loaded' "$OUT/guard-check.log" | cut -c1-120 | tee -a "$SUMMARY" || true
	say "plugins in init:"
	jq -r 'select(.type=="system" and .subtype=="init") | .plugins[].source' "$OUT/guard-check.jsonl" | sed 's/^/  /' | tee -a "$SUMMARY" || true
	say "apiKeySource: $(jq -r 'select(.type=="system" and .subtype=="init") | .apiKeySource' "$OUT/guard-check.jsonl" | sort -u | tr '\n' ' ')"
	say "claude: $(claude --version 2>&1 | head -1)"
	if [ "$seated" != 0 ] || [ "$bypassed" != 0 ]; then
		say ""
		say "STOP: the built-in guard cc-plugin-sec-default is loaded on this machine ($seated seated line(s), $bypassed bypassed line(s))."
		say "It skips the prompt.compose hook of the mod, so a live run here cannot show whether the model reads the section."
		say "Use a machine with no managed settings. A Team or Enterprise sign-in can also seat the guard (server-managed settings)."
		grep -E 'sec-default@builtin seated|bypassed by' "$OUT/guard-check.log" | cut -c1-240 | head -5 | tee -a "$SUMMARY" || true
		exit 3
	fi
	say "guard not seated: go on."
}

# --- arms (runbook 3) --------------------------------------------------------------------------------------------
write_configs() {
	local arm a on
	for arm in A:false B:true C:true D:false; do
		a=${arm%%:*}
		on=${arm##*:}
		mkdir -p "$W/cfg/$a"
		cat >"$W/cfg/$a/config.json" <<JSON
{
  "version": 1,
  "trackers": {
    "web": { "prompt": { "enabled": $on } }
  }
}
JSON
	done
}

# run_arm <A|B|C|D> <six|compact>
run_arm() {
	local ARM=$1 PLAN=$2 SNAP
	case "$ARM" in
	A | B) SNAP=on ;;
	C | D) SNAP=off ;;
	esac
	local RUN="$ARM-$PLAN"
	local DBG="$OUT/$RUN.debug.log"
	local MARKS="$OUT/$RUN.marks.tsv"
	# Start from empty files: the debug file appends.
	: >"$MARKS"
	: >"$DBG"

	local LA='https://example.com/canary-a' LB='https://example.com/canary-b' LC='https://example.com/canary-c'
	local Q='Quote the line of your system prompt that starts with web: or answer NONE.'
	local QALL='Quote every line of your system prompt that starts with web: or answer NONE.'
	local FRAME='Does your system prompt contain a line that starts with "Items tracked in this session"? Answer YES or NO.'
	local -a MSG
	case "$PLAN" in
	six)
		MSG=(
			"Remember this link, do not open it: $LA . Reply OK."
			"What is 2+2? Reply with the digit only."
			"Name one colour. Reply with one word."
			"Remember this second link, do not open it: $LB . Reply OK."
			"Name one animal. Reply with one word."
			"$Q"
		)
		;;
	compact)
		MSG=(
			"Remember this link, do not open it: $LA . Reply OK."
			"What is 2+2? Reply with the digit only."
			"Remember this second link, do not open it: $LB . Reply OK."
			"Name one colour. Reply with one word."
			"$QALL"
			"/compact"
			"$QALL"
			"Remember this third link, do not open it: $LC . Reply OK."
			"Name one animal. Reply with one word."
			"$QALL"
			"$FRAME"
		)
		;;
	esac

	# Send one stream-json message at a time. Wait 12 s after a message, 60 s after /compact.
	# MARKS: message number, epoch seconds, lines of the debug log before the send, text.
	send() {
		local i=0 m n
		for m in "${MSG[@]}"; do
			i=$((i + 1))
			n=0
			if [ -f "$DBG" ]; then n=$(wc -l <"$DBG" | tr -d ' '); fi
			printf '%s\t%s\t%s\t%s\n' "$i" "$(date +%s)" "$n" "$m" >>"$MARKS"
			jq -nc --arg t "$m" '{type:"user",message:{role:"user",content:$t}}'
			if [ "$m" = "/compact" ]; then sleep 60; else sleep 12; fi
		done
		sleep 20
	}

	echo "arm $ARM, plan $PLAN, snapshot $SNAP"
	cd "$W/proj"
	# A failed arm keeps its files for the report, but the script exits nonzero at the end (exit 6).
	if ! send | CLAUDE_TRACKER_CONFIG_DIR="$W/cfg/$ARM" claude -p \
		--input-format stream-json --output-format stream-json --verbose \
		--model haiku \
		--plugin-dir "$PLUGIN" \
		--setting-sources project \
		--system-prompt-snapshot "$SNAP" \
		--debug-file "$DBG" \
		>"$OUT/$RUN.jsonl" 2>"$OUT/$RUN.stderr"; then
		echo "arm $RUN: claude failed (see $RUN.stderr)"
		FAILED_ARMS+=("$RUN")
	fi
	cd "$W"
	cp "$W/cfg/$ARM/config.json" "$OUT/$RUN.config-after.json" 2>/dev/null || true
}

# --- reports (runbook 4) -----------------------------------------------------------------------------------------
report() {
	local RUN="$1-${2:-six}"
	local O="$OUT/$RUN" J D M
	J="$O.jsonl"
	D="$O.debug.log"
	M="$O.marks.tsv"
	if ! { [ -f "$J" ] && [ -f "$D" ] && [ -f "$M" ]; }; then
		echo "== $RUN: no output"
		return 0
	fi

	echo "== $RUN: message n, text, requests, cache create, cache read, answer"
	paste <(cut -f1,4 "$M" | cut -c1-60) \
		<(jq -r 'select(.type=="result") | [.num_turns, .usage.cache_creation_input_tokens, .usage.cache_read_input_tokens, (.result | gsub("\\s+"; " ") | .[0:160])] | @tsv' "$J")

	echo
	echo "== guard signals (all must be 0)"
	echo "seated lines in the debug log:      $(grep -c 'sec-default@builtin seated' "$D" || true)"
	echo "bypassed lines in the debug log:    $(grep -c 'bypassed by' "$D" || true)"
	echo "ui_log messages in the stream:      $(jq -c 'select(.type=="system" and .subtype=="ui_log")' "$J" | wc -l | tr -d ' ')"
	echo "sec-default lines (diagnostic):     $(grep -c 'sec-default' "$D" || true)"

	echo
	echo "== plugins listed by the init messages (diagnostic: one artifact-tracking@inline)"
	jq -r 'select(.type=="system" and .subtype=="init") | .plugins[].source' "$J" | sort | uniq -c
	echo "apiKeySource: $(jq -r 'select(.type=="system" and .subtype=="init") | .apiKeySource' "$J" | sort -u | tr '\n' ' ')"

	echo
	echo "== lines of the mod in the debug log"
	grep -E 'artifact-tracking@inline loaded|prompt: section (rebuilt|removed)|prompt: (compose|rebuild) failed|artifact-tracking: prompt\.compose|artifact-tracking@inline prompt\.compose' "$D" | cut -c1-240 || true

	echo
	echo "== prompt.compose runs per window (window i = debug lines written after message i was sent)"
	echo "window  mod-lines  all-lines  message"
	awk -F'\t' -v MP='artifact-tracking@inline prompt\\.compose settled' -v AP='prompt\\.compose settled' '
  NR == FNR { ln[NR] = $3; txt[NR] = substr($4, 1, 40); n = NR; next }
  {
    w = 0
    for (i = 1; i <= n; i++) if (FNR > ln[i]) w = i
    if ($0 ~ MP) mod[w]++
    if ($0 ~ AP) all[w]++
  }
  END { for (i = 0; i <= n; i++) printf "%6d  %9d  %9d  %s\n", i, mod[i] + 0, all[i] + 0, txt[i] }
' "$M" "$D"

	if [ "${2:-six}" = compact ]; then
		echo
		echo "== compaction"
		jq -c 'select(.subtype=="compact_boundary") | .compact_metadata | {trigger, pre_tokens, post_tokens, duration_ms}' "$J"
	fi
}

table() {
	cd "$OUT"
	local arms=() a
	for a in A B C D; do
		[ -f "$a-six.jsonl" ] || continue
		arms+=("$a")
		jq -r 'select(.type=="result") | "\(.usage.cache_creation_input_tokens)/\(.usage.cache_read_input_tokens)"' "$a-six.jsonl" | head -6 >"$a-six.tok"
	done
	if [ "${#arms[@]}" -eq 0 ]; then
		echo "no six-message runs"
		cd "$W"
		return 0
	fi
	echo "cache create/read tokens per turn"
	{
		printf 'turn'
		for a in "${arms[@]}"; do printf '\t%s' "$a"; done
		printf '\n'
		local files=()
		for a in "${arms[@]}"; do files+=("$a-six.tok"); done
		paste <(seq 1 6) "${files[@]}"
	} | column -t -s "$(printf '\t')"
	echo
	echo "canary answer (turn 6)"
	for a in "${arms[@]}"; do
		printf '%s: ' "$a"
		jq -rs '[.[] | select(.type=="result")][5].result // "no turn 6" | gsub("\\s+"; " ")' "$a-six.jsonl"
	done
	cd "$W"
}

# --- main --------------------------------------------------------------------------------------------------------
: >"$SUMMARY"
say "# prompt-section live run (issue #91)"
say "mode: $MODE"
say "os: $(uname -sr)"
say "mod checkout: $(git -C "$CLONE" log -1 --format='%H %s' 2>/dev/null || echo unknown)"
say ""
guard_check
if [ "$MODE" = guard-only ]; then exit 0; fi

write_configs
set +e # keep collecting diagnostics when one arm failed; the exit status below carries the failure
for a in A B C D; do run_arm "$a" six; done
run_arm B compact
run_arm C compact

{
	echo
	echo "## table"
	table
	for r in A:six B:six C:six D:six B:compact C:compact; do
		echo
		report "${r%%:*}" "${r##*:}"
	done
	echo
	echo "## not run"
	echo "processes endedTtlMs addendum (issue comment 2): not run. It needs the /track pane and a background Bash task."
	echo "The pane exists only in the interactive TUI. claude -p has no pane, so a headless run cannot show the Processes row."
	echo "Run it by hand on a machine without the guard."
	if [ "${#FAILED_ARMS[@]}" -gt 0 ]; then
		echo
		echo "## FAILED ARMS"
		printf 'arm failed: %s\n' "${FAILED_ARMS[@]}"
	fi
} >>"$SUMMARY" 2>&1
sed -n '/^## table/,$p' "$SUMMARY"
if [ "${#FAILED_ARMS[@]}" -gt 0 ]; then
	echo "FAILED: ${#FAILED_ARMS[@]} arm run(s) failed: ${FAILED_ARMS[*]}" >&2
	exit 6
fi
