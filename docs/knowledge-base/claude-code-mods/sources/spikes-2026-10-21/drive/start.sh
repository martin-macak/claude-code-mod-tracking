#!/bin/zsh
# usage: start.sh <port> <cfg-name> [claude args...]  -> a tmux session "s" on socket i71spike, past the trust dialog
S=<SPIKES>
tmux -L i71spike kill-server 2>/dev/null
tmux -L i71spike new-session -d -s s -x 120 -y 40 "$S/launch.sh $*"
for i in {1..30}; do
  sleep 1
  screen=$(tmux -L i71spike capture-pane -p -t s)
  if print -r -- "$screen" | grep -q "Yes, I trust this folder"; then
    tmux -L i71spike send-keys -t s Down
    sleep 1
    tmux -L i71spike send-keys -t s Enter
  fi
  if print -r -- "$screen" | grep -q "^❯ "; then
    echo ready
    exit 0
  fi
done
echo "not ready"
tmux -L i71spike capture-pane -p -t s
exit 1
