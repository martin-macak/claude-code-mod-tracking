#!/bin/zsh
# usage: runclaude.sh <cwd> <args...>   (scrubbed env, fake API, isolated config dir)
SP=<scratch>
cwd=$1; shift
cd $cwd
env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') \
  CLAUDE_CONFIG_DIR=$SP/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:8799 ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  perl -e 'alarm 120; exec @ARGV' ${CLAUDE_BIN:-$HOME/.local/share/claude/versions/2.1.295} "$@"
