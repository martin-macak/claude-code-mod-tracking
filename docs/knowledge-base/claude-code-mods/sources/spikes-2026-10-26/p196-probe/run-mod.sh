#!/bin/zsh
# Launcher for the baseline run of the real mod (a copy in the scratchpad), same clean environment as run.sh.
S=<SCRATCH>
cd $S/work
exec env -u CLAUDECODE -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SSE_PORT $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') \
  CLAUDE_CONFIG_DIR=$S/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT:-8796} ANTHROPIC_AUTH_TOKEN=fake CLAUDE_TRACKER_CONFIG_DIR=$S/trackcfg \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_NO_FLICKER=${NOFLICKER:-0} \
  perl -e "alarm ${ALARM:-240}; exec @ARGV" $HOME/.local/share/claude/versions/2.1.310 --plugin-dir $S/modcopy/artifact-tracking --permission-mode bypassPermissions "$@"
