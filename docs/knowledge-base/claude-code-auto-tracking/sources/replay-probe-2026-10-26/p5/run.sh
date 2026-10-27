#!/bin/zsh
# usage: run.sh <port> <claude args...>   (P5: the TUI runs, control and treatment)
SPD=<scratch>
port=$1; shift
cd <scratch>/repo
env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') \
  PATH=$SPD/bin:$PATH CLAUDE_CONFIG_DIR=$SPD/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:$port ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_TRACKER_CONFIG_DIR=$SPD/trkcfg CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  perl -e 'alarm ${ALARM:-240}; exec @ARGV' $HOME/.local/share/claude/versions/2.1.310 "$@"
