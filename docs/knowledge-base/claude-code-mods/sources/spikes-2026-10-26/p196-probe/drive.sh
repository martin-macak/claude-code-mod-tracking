#!/bin/bash
# Tiny tmux driver for the issue 196 probe. Private socket p196 only.
#   drive.sh type "<text>"      types the text, then Enter
#   drive.sh key <key>...       sends keys (Enter, Down, C-o, Escape)
#   drive.sh cap <file>         captures the pane with 400 lines of history
set -e
T=(tmux -L p196)
case "$1" in
  type) "${T[@]}" send-keys -t tui -l "$2"; sleep 1; "${T[@]}" send-keys -t tui Enter; sleep "${3:-3}" ;;
  key) shift; "${T[@]}" send-keys -t tui "$@"; sleep 2 ;;
  cap) "${T[@]}" capture-pane -p -t tui -S -400 > "$2" ;;
esac
