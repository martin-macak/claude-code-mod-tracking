#!/bin/zsh
S=<SCRATCH>
cd $S/work
exec env -u CLAUDECODE -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SSE_PORT $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') \
  CLAUDE_CONFIG_DIR=$S/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT:-8846} ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_NO_FLICKER=${NOFLICKER:-0} \
  perl -e "alarm ${ALARM:-240}; exec @ARGV" $HOME/.local/share/claude/versions/${CCV:-2.1.311} --plugin-dir $S/probe --permission-mode bypassPermissions "$@"
