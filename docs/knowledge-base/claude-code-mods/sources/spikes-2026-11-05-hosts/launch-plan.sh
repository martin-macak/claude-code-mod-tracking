#!/bin/sh
# Start claude (haiku, plan mode) with the mod and the plan probe, and EDITOR set to editor.sh.
# Run it in tmux: tmux -L i312spike new-session -d -s plan -x 200 -y 50 "<SPIKES>/launch-plan.sh <work dir> <out dir>"
# MOD is the absolute path of plugins/artifact-tracking.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$1 out=$2
: "${MOD:?set MOD}"
mkdir -p "$out/probe"
cp -R "$here/plan-probe/." "$out/probe/"
sed "s#<OUT>#$out#" "$here/plan-probe/hooks/register.ts" > "$out/probe/hooks/register.ts"
cd "$work"
exec env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_MESSAGING_SOCKET \
  -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH \
  EDITOR="$here/editor.sh" VISUAL="$here/editor.sh" EDITOR_LOG="$out/editor.log" \
  claude --model haiku --permission-mode plan --plugin-dir "$MOD" --plugin-dir "$out/probe"
