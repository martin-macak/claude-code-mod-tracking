#!/usr/bin/env python3
"""Print the OSC 8 spans in a raw pty capture, in order: URL, params, label.
A new OSC 8 open ends the span before it (the renderer does not always send a close between two links).
usage: osc8-spans.py capture.bin"""
import re, sys
b = open(sys.argv[1], 'rb').read().decode('utf8', 'replace')
OSC = re.compile(r'\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)')
CSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]')
def visible(s):
    s = re.sub(r'\x1b\[\d*[GC]', ' ', s)          # cursor moves stand for spaces
    return CSI.sub('', s).replace('\r\r\n', '\n').replace('\r', '')
spans, cur, pos = [], None, 0
for m in OSC.finditer(b):
    if cur is not None:
        cur['label'] += visible(b[pos:m.start()])
    if cur is not None:
        spans.append(cur); cur = None
    if m.group(2) != '':
        cur = {'params': m.group(1), 'url': m.group(2), 'label': ''}
    pos = m.end()
if cur: spans.append(cur)
seen = set()
for s in spans:
    key = (s['params'], s['url'])
    if key in seen:        # same id and URI: one link drawn in pieces
        continue
    seen.add(key)
    print(f"{s['url']}\t{s['params'].split(':')[0][:3]}\t{s['label'].strip()!r}")
