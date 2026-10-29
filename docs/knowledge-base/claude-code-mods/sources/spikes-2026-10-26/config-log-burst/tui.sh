#!/bin/zsh
# usage: tui.sh <keys> <tag>   one INTERACTIVE claude session (private tmux socket p219) with the real mod and <keys> unknown config keys
SP=<SCRATCH>
N=$1; TAG=$2
PLUGIN=<REPO>/plugins/artifact-tracking
R=$SP/runs/$TAG; rm -rf $R; mkdir -p $R/cfg $R/trk $R/gh $R/home
WORK=$(cd $SP/work && pwd -P)
node -e '
const n=+process.argv[1];
const g=Object.fromEntries(Array.from({length:n},(_,i)=>["k"+i,i]));
process.stdout.write(JSON.stringify({version:1,global:g}));
' $N > $R/trk/config.json
node -e '
const w=process.argv[1];
process.stdout.write(JSON.stringify({hasCompletedOnboarding:true,theme:"dark",projects:{[w]:{hasTrustDialogAccepted:true,allowedTools:[]}}}));
' $WORK > $R/cfg/.claude.json
uptime > $R/uptime.txt; claude --version > $R/version.txt
tmux -L p219 kill-server 2>/dev/null
tmux -L p219 -f /dev/null new-session -d -s tui -x 160 -y 45 "cd $WORK && exec env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ') HOME=$R/home CLAUDE_CONFIG_DIR=$R/cfg CLAUDE_TRACKER_CONFIG_DIR=$R/trk GH_CONFIG_DIR=$R/gh ANTHROPIC_BASE_URL=http://127.0.0.1:8821 ANTHROPIC_AUTH_TOKEN=fake CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 claude --plugin-dir $PLUGIN --tools '' --strict-mcp-config --debug-file $R/debug.log"
for i in $(seq 1 60); do grep -q "artifact-tracking@inline session.start settled" $R/debug.log 2>/dev/null && break; sleep 0.5; done
sleep 4
tmux -L p219 capture-pane -p -t tui > $R/screen.txt
tmux -L p219 send-keys -t tui "/exit" Enter
for i in $(seq 1 20); do tmux -L p219 has-session -t tui 2>/dev/null || break; sleep 0.5; done
tmux -L p219 kill-server 2>/dev/null
