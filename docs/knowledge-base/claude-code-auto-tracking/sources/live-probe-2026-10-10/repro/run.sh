#!/bin/zsh
SP=/private/tmp/claude-501/-Users-user-projects-claude-code-mod-tracking/29484de1-cef4-4282-97e8-750e88984c88/scratchpad
cwd=$1; shift
cd $cwd
env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') \
  PATH=$SP/bin:$PATH CLAUDE_CONFIG_DIR=$SP/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT:-8799} ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  perl -e 'alarm 90; exec @ARGV' ${CLAUDE_BIN:-$HOME/.local/share/claude/versions/2.1.295} "$@"
