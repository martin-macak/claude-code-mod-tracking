#!/bin/zsh
# usage: run.sh <seq-file> <name> [claude args]  -> restarts the fake API on 8808 with the sequence and a fresh session
S=<SPIKES>
seq=$1; name=$2; shift 2
pkill -f "node fake-api.mjs" 2>/dev/null
cd $S
mkdir -p out
rm -f out/*(N)
PORT=8808 SEQ=$S/$seq LOG=$S/req-$name.ndjson SCHEMA=$S/ask-tool-schema.json nohup node fake-api.mjs > fake.log 2>&1 &
sleep 1
$S/start.sh 8808 $name "$@" > /dev/null
sleep 1
tmux -L i208spike capture-pane -p -t s | grep -c "Claude Code"
