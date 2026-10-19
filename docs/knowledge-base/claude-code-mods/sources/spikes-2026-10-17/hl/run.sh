#!/bin/zsh
# usage: hl/run.sh <plugin-dir> "<prompt>"   -> fresh config dir, headless claude -p against the fake API on :8793
S=<SPIKES>
plug=$1; prompt=$2
cfg=$S/hl/cfg-$(basename $plug)-$$; rm -rf $cfg; mkdir -p $cfg $S/hl/work
echo '{"hasCompletedOnboarding":true}' > $cfg/.claude.json
cd $S/hl/work
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_ENTRYPOINT \
  CLAUDE_CONFIG_DIR=$cfg ANTHROPIC_BASE_URL=http://127.0.0.1:8793 ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  perl -e 'alarm shift; exec @ARGV' ${HL_TIMEOUT:-60} claude -p "$prompt" --plugin-dir $S/$plug --debug-file $cfg/debug.log 2>&1 < /dev/null
echo "exit=$?"
echo "CFG=$cfg"
