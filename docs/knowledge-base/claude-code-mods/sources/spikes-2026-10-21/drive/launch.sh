#!/bin/zsh
# usage: launch.sh <port> <cfg-name> [claude args...]   -> runs claude in the foreground against the fake API, isolated config
S=<SPIKES>
port=$1; cfgname=$2; shift 2
cfg=$S/cfg-$cfgname
rm -rf $cfg; mkdir -p $cfg $S/work
echo '{"hasCompletedOnboarding":true}' > $cfg/.claude.json
cd $S/work
exec env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH \
  CLAUDE_CONFIG_DIR=$cfg ANTHROPIC_BASE_URL=http://127.0.0.1:$port ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  claude --plugin-dir $S/mod "$@"
