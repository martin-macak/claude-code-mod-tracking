#!/bin/bash
# Headless smoke run (rerun at 2d1ea8d). usage: run-p.sh <plugin-dir> <smoke-dir> <fake-api.mjs> <port>
set -u
PLUGIN="$1"; S="$2"; API="$3"; PORT="$4"
for v in $(env | grep -o '^CLAUDE_CODE_[A-Za-z0-9_]*'); do unset "$v"; done
unset CLAUDECODE CLAUDE_CONFIG_DIR
export CLAUDE_CONFIG_DIR="$S/cfg" ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_AUTH_TOKEN=fake DISABLE_AUTOUPDATER=1
echo "CLAUDE_CODE_* variables left in the child environment: $(env | grep -c '^CLAUDE_CODE_')" > "$S/out/00-env.txt"
PORT=$PORT REPLY_FILE="$S/reply.txt" node "$API" > "$S/out/fake-api.log" 2>&1 &
API_PID=$!
sleep 1
cd "$S/proj"
claude --version > "$S/out/01-version.txt" 2>&1
claude -p --plugin-dir "$PLUGIN" --debug-file "$S/out/debug-1.txt" "Please check #14622 and tell me where the fix is." > "$S/out/10-run1-prompt.txt" 2>&1
echo "exit=$?" >> "$S/out/10-run1-prompt.txt"
claude -p --plugin-dir "$PLUGIN" --continue --debug-file "$S/out/debug-2.txt" "/track" > "$S/out/20-run2-track.txt" 2>&1
echo "exit=$?" >> "$S/out/20-run2-track.txt"
claude -p --plugin-dir "$PLUGIN" --continue --debug-file "$S/out/debug-3.txt" "/track refresh" > "$S/out/30-run3-track-refresh.txt" 2>&1
echo "exit=$?" >> "$S/out/30-run3-track-refresh.txt"
kill $API_PID 2>/dev/null
echo done
