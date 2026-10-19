#!/usr/bin/env python3
"""an.py LABEL...  analyze out/cap-LABEL.ansi: per line, row id, ring (inverse) and highlight (bg other than pane bg)."""
import re, sys
OUT = '<SPIKES>/live2-table/out'
PANE_BG = {'235', '237', '16', '49', '0'}
ESC = re.compile(r'\x1b\[([0-9;]*)m')
def analyze(label):
    out = []
    for i, line in enumerate(open(f'{OUT}/cap-{label}.ansi').read().split('\n')):
        plain = ESC.sub('', line)
        # only the pane part (after the border │)
        pane = plain.split('│', 1)[1] if '│' in plain else plain
        inv = False; bgs = set(); inv_text = ''
        state_inv = False; cur_bg = None
        pos = 0; seg_inv = []
        for m in ESC.finditer(line):
            text = line[pos:m.start()]
            if state_inv and text.strip(): seg_inv.append(text)
            pos = m.end()
            for code in (m.group(1) or '0').split(';'):
                pass
            codes = (m.group(1) or '0').split(';')
            j = 0
            while j < len(codes):
                c = codes[j]
                if c == '7': state_inv = True
                elif c in ('27', '0'): state_inv = False
                if c == '48' and j + 2 < len(codes) and codes[j+1] == '5':
                    bgs.add(codes[j+2]); j += 2
                elif c == '48' and j + 4 < len(codes) and codes[j+1] == '2':
                    bgs.add('rgb' + ','.join(codes[j+2:j+5])); j += 4
                j += 1
            if m.group(1) in ('7',): state_inv = True
        tail = line[pos:]
        if state_inv and tail.strip(): seg_inv.append(tail)
        m = re.search(r'#(\d+)\b', pane)
        rid = f'#{m.group(1)}' if m else ''
        hl = bgs - PANE_BG
        if seg_inv or hl:
            out.append((i, rid, ''.join(seg_inv).strip(), sorted(hl), pane.strip()[:60]))
    return out
for lb in sys.argv[1:]:
    print(f'--- {lb}')
    for i, rid, inv, hl, txt in analyze(lb):
        print(f'  line {i:2d} row={rid or "-":5s} ring={inv!r:12s} highlight_bg={hl}   | {txt}')
