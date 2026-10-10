#!/bin/zsh
# usage: tmux-run.sh <name> <cols> <rows> <extra env assignments or ''> -- <claude args...>
SP=<scratch>
name=$1; cols=$2; rows=$3; xenv=$4; shift 5
tmux -L probe kill-server 2>/dev/null
unsetopt nomatch
cleanvars=$(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ')
cmd="cd ~/projects/claude-code-mod-tracking && env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $cleanvars CLAUDE_CONFIG_DIR=$SP/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:8799 ANTHROPIC_AUTH_TOKEN=fake CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 TERM=xterm-256color $xenv $HOME/.local/share/claude/versions/2.1.295 $*"
tmux -L probe new-session -d -s $name -x $cols -y $rows "$cmd"
