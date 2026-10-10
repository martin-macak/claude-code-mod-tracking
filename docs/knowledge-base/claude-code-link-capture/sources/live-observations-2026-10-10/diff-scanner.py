#!/usr/bin/env python3
"""Compare the scanner with the renderer's real output.
usage: diff-scanner.py cN   (reads corpora/cN-*.md and ground-truth/cN.tsv)
The renderer draws the same URL twice as two links with one id; the ground truth keeps one of them, so a
repeated URL in the scanner output is not a difference (it is merged later by mergeLinks)."""
import glob, json, subprocess, sys, os
here = os.path.dirname(os.path.abspath(__file__))
n = sys.argv[1]
corpus = glob.glob(f'{here}/corpora/{n}-*.md')[0]
truth = [l.split('\t')[0] for l in open(f'{here}/ground-truth/{n}.tsv').read().splitlines()]
out = subprocess.run(['node', f'{here}/scan-file.mts', corpus], capture_output=True, text=True, check=True).stdout.splitlines()
mine = []
for l in out:
    f = json.loads(l)
    if f['kind'] == 'link' and f['url'] not in mine:
        mine.append(f['url'])
truth_u = []
for u in truth:
    if u not in truth_u:
        truth_u.append(u)
print(f'{n}: renderer {len(truth_u)} links, scanner {len(mine)} links')
only_r = [u for u in truth_u if u not in mine]
only_s = [u for u in mine if u not in truth_u]
for u in only_r: print('  only in renderer:', u)
for u in only_s: print('  only in scanner :', u)
sys.exit(1 if only_r or only_s or truth_u != [u for u in mine if u in truth_u] else 0)
