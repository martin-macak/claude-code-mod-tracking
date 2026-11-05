#!/bin/sh
# Run one variant of the stdio host in an empty git repo, with the mod loaded.
# Usage: run-host.sh <variant a|b|c|d> <repo dir> <out dir> [extended 1|0]
# extended 1: CLAUDE_CODE_ENTRYPOINT=sdk-cli CLAUDE_CODE_QUESTION_EXTENDED=1 (the questions carry `kind`).
# extended 0: the stock entrypoint of `claude -p` (no `kind`).
# <MOD> is plugins/artifact-tracking; set MOD to its absolute path.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
variant=$1 repo=$2 out=$3 ext=${4:-1}
: "${MOD:?set MOD to the absolute path of plugins/artifact-tracking}"
if [ "$ext" = 1 ]; then
  export HOST_ENTRYPOINT=sdk-cli CLAUDE_CODE_QUESTION_EXTENDED=1
  kind='kind "choice", '
else
  unset HOST_ENTRYPOINT CLAUDE_CODE_QUESTION_EXTENDED
  kind=''
fi
export VARIANT="$variant" OUT="$out"
export PROMPT="Use the AskUserQuestion tool once. Ask one question: \"Which database should we use?\" with header \"DB\", ${kind}options Postgres and SQLite. After the answer, reply in one short sentence and stop."
# The probe writes what the tool.call hook sees to <out>.
mkdir -p "$out/probe"
cp -R "$here/plan-probe/." "$out/probe/"
sed "s#<OUT>#$out#" "$here/plan-probe/hooks/register.ts" > "$out/probe/hooks/register.ts"
cd "$repo"
exec node "$here/host.mjs" -p --input-format stream-json --output-format stream-json --verbose \
  --permission-prompt-tool stdio --model haiku --max-turns 4 --plugin-dir "$MOD" --plugin-dir "$out/probe"
