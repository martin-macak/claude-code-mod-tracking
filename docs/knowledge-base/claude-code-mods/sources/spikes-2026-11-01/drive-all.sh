#!/bin/zsh
# Drives seq-all.json: text + number, a comma label with a typed piece, a typed piece with quote and comma, Chat about this.
T() { tmux -L i208spike send-keys -t s "$@" }
T "go" Enter; sleep 5
T -l "acme-app"; T Enter; sleep 1
T -l "12"; T Enter; sleep 1
T Enter; sleep 4
# comma label: A, "A, custom", typed piece
T Enter Down Enter Down Down; sleep 0.5; T -l "typed piece"; sleep 0.5; T Down Enter; sleep 1; T Enter; sleep 4
# typed piece with quote and comma
T Enter Down Down; sleep 0.5; T -l 'say "hi", ok'; sleep 0.5; T Down Enter; sleep 1; T Enter; sleep 4
# chat about this
T Down Down Down; sleep 0.5; T Enter; sleep 4
T "/track qa" Enter; sleep 3
tmux -L i208spike capture-pane -p -t s -S -60
