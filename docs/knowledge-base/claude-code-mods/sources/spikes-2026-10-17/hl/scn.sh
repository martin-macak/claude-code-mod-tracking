#!/bin/zsh
# usage: hl/scn.sh <plugin> "<prompt>"  -> run + print stdout line and the store records (rec, stats)
S=<SPIKES>
out=$($S/hl/run.sh "$1" "$2"); cfg=$(echo "$out" | sed -n 's/^CFG=//p')
echo "== $2"; echo "$out" | grep -v '^CFG=\|^Warning'
f=$(ls $cfg/plugins/store/*.json 2>/dev/null | head -1)
[ -n "$f" ] && python3 - "$f" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
d=d.get('data',d) if isinstance(d,dict) else d
for k,v in d.items():
    if k=='rec':
        for l in json.loads(v) if isinstance(v,str) else v: print('   '+l)
    else: print('   ['+k+'] '+(v if isinstance(v,str) else json.dumps(v)))
PY
rm -rf $cfg
