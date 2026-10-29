#!/bin/zsh
# usage: runlp.sh <keys> <batch> <tag>   headless run with ONLY the logprobe plugin
SP=<SCRATCH>
N=$1; B=$2; TAG=$3
R=$SP/runs/$TAG; rm -rf $R; mkdir -p $R/cfg $R/home
echo "{\"hasCompletedOnboarding\":true,\"theme\":\"dark\"}" > $R/cfg/.claude.json
cd $SP/work; uptime > $R/uptime.txt
env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') \
  HOME=$R/home CLAUDE_CONFIG_DIR=$R/cfg PROBE_KEYS=$N PROBE_BATCH=$B ANTHROPIC_BASE_URL=http://127.0.0.1:8821 ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  perl -e 'alarm 120; exec @ARGV' claude -p "ok" --plugin-dir $SP/probe/logprobe --tools '' --strict-mcp-config \
    --debug-file $R/debug.log --output-format json > $R/out.json 2> $R/err.txt
