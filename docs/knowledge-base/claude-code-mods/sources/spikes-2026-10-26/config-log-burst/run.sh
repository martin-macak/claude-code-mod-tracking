#!/bin/zsh
# usage: run.sh <keys> <tag>   one headless claude -p run of the real mod with <keys> unknown config keys
SP=<SCRATCH>
N=$1; TAG=$2
PLUGIN=<REPO>/plugins/artifact-tracking
R=$SP/runs/$TAG; rm -rf $R; mkdir -p $R/cfg $R/trk $R/gh $R/home
node -e '
const n=+process.argv[1];
const g=Object.fromEntries(Array.from({length:n},(_,i)=>["k"+i,i]));
process.stdout.write(JSON.stringify({version:1,global:g}));
' $N > $R/trk/config.json
echo "{\"hasCompletedOnboarding\":true,\"theme\":\"dark\"}" > $R/cfg/.claude.json
cd $SP/work
if [ "$DBGMODE" = default ]; then DBG=(--debug); else DBG=(--debug-file $R/debug.log); fi
uptime > $R/uptime.txt
claude --version > $R/version.txt
S=$(python3 -c 'import time;print(time.time())')
env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') \
  HOME=$R/home CLAUDE_CONFIG_DIR=$R/cfg CLAUDE_TRACKER_CONFIG_DIR=$R/trk GH_CONFIG_DIR=$R/gh \
  ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT:-8821} ANTHROPIC_AUTH_TOKEN=fake \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  /usr/bin/time -l perl -e 'alarm 120; exec @ARGV' claude -p "ok" --plugin-dir $PLUGIN --tools '' --strict-mcp-config \
    "${DBG[@]}" --output-format json > $R/out.json 2> $R/time.txt
[ -e $R/cfg/debug/latest ] && cp -L $R/cfg/debug/latest $R/debug.log
E=$(python3 -c 'import time;print(time.time())')
python3 -c "print('wall_s', round($E-$S,3))" > $R/wall.txt
