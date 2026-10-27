#!/bin/zsh
# usage: run.sh <cwd> <port> <claude args...>
SP=<scratch>
cwd=$1; port=$2; shift 2
cd $cwd
env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') \
  PATH=$SP/bin:$PATH CLAUDE_CONFIG_DIR=$SP/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:$port ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  perl -e 'alarm ${ALARM:-120}; exec @ARGV' $HOME/.local/share/claude/versions/2.1.310 "$@"
