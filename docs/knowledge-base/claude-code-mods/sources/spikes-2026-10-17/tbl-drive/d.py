#!/usr/bin/env python3
"""d.py <cmd> ...  tmux driver for the table spike (private server arch-spike2-table).
  start [extra claude args]   start claude in a detached tmux session, answer the trust dialog, wait for the prompt
  screen [-e] [-S n]          print the screen (plain, or with colors; -S n: n scrollback lines)
  keys LABEL KEY...           send keys, wait until the screen settles, save out/cap-LABEL.{txt,ansi}, print plain
  lit LABEL TEXT              send literal text (no Enter)
  cmd LABEL TEXT              type TEXT, wait, Enter, settle, save
  perf LABEL N [KEY]          send KEY (default Tab) N times, one at a time; time each step (first screen change, last change)
  kill                        kill the tmux server
"""
import os, re, subprocess, sys, time
SOCK = 'arch-spike2-table'
S = '<SPIKES>'
CWD = f'{S}/live2-table'
OUT = f'{CWD}/out'
MOD = f'{S}/tbl'
CONF = f'{S}/tbl-drive/tmux.conf'
UNSET = 'CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_EXECPATH'

def tmux(*a, check=False):
    r = subprocess.run(['tmux', '-u', '-L', SOCK, *a], capture_output=True, text=True)
    return r.stdout
def cap(e=False, scroll=0):
    args = ['capture-pane', '-p', '-t', SOCK]
    if e: args.insert(2, '-e')
    if scroll: args += ['-S', f'-{scroll}']
    return tmux(*args)
def settle(quiet=0.6, secs=10):
    prev = None; since = time.time(); end = time.time() + secs
    while time.time() < end:
        cur = cap(True)
        if cur != prev: prev, since = cur, time.time()
        elif time.time() - since >= quiet: break
        time.sleep(0.12)
def save(label):
    os.makedirs(OUT, exist_ok=True)
    open(f'{OUT}/cap-{label}.txt', 'w').write(cap())
    open(f'{OUT}/cap-{label}.ansi', 'w').write(cap(True))
    print(f'=== {label} ===')
    print(cap().rstrip())
def keys(label, ks, quiet=0.6):
    for k in ks:
        tmux('send-keys', '-t', SOCK, k); time.sleep(0.15)
    settle(quiet); save(label)

def start(extra):
    if subprocess.run(['tmux', '-L', SOCK, 'has-session', '-t', SOCK], capture_output=True).returncode == 0:
        print('session exists'); return
    claude = ' '.join(['claude', '--plugin-dir', MOD, '--setting-sources', 'project', *extra])
    cmd = f'exec env {" ".join("-u " + v for v in UNSET.split())} {claude}'
    subprocess.run(['tmux', '-u', '-L', SOCK, '-f', CONF, 'new-session', '-d', '-s', SOCK, '-x', '120', '-y', '40', '-c', CWD,
                    '-e', 'COLORTERM=truecolor', cmd], check=True)
    end = time.time() + 60
    while time.time() < end:
        s = cap()
        if 'Yes, I trust this folder' in s:
            if re.search(r'❯\s+Yes, I trust this folder', s): tmux('send-keys', '-t', SOCK, 'Enter')
            else: tmux('send-keys', '-t', SOCK, 'Down')
            time.sleep(0.8); continue
        if re.search(r'^❯\s', s, re.M): print('ready'); print(s.rstrip()); return
        time.sleep(0.5)
    print('NOT READY'); print(cap())

def perf(label, n, key):
    rows = []
    prev = cap(True)
    for i in range(n):
        t0 = time.time()
        tmux('send-keys', '-t', SOCK, key)
        first = last = None
        end = t0 + 6
        base = prev
        while time.time() < end:
            cur = cap(True)
            now = time.time()
            if cur != base:
                if first is None: first = now
                last = now; base = cur
            elif first is not None and now - last > 0.35:
                break
        rows.append((t0, first, last))
        prev = base
        time.sleep(0.05)
    print(f'PERF {label} key={key} n={n}')
    for i, (t0, f, l) in enumerate(rows):
        print(f'  step {i+1:2d}: t0={t0*1000:.0f} first_change={(f-t0)*1000 if f else -1:.0f}ms last_change={(l-t0)*1000 if l else -1:.0f}ms')
    fs = [(f - t0) * 1000 for t0, f, l in rows if f]; ls = [(l - t0) * 1000 for t0, f, l in rows if l]
    if fs: print(f'  first_change: mean={sum(fs)/len(fs):.0f}ms min={min(fs):.0f} max={max(fs):.0f}   last_change: mean={sum(ls)/len(ls):.0f}ms min={min(ls):.0f} max={max(ls):.0f}')
    print(f'  wall total for {n} steps: {(rows[-1][2] or rows[-1][0]) - rows[0][0]:.2f}s  (t0 of step1={rows[0][0]*1000:.0f})')

if __name__ == '__main__':
    c = sys.argv[1]; a = sys.argv[2:]
    if c == 'start': start(a)
    elif c == 'screen':
        e = '-e' in a; sc = 0
        if '-S' in a: sc = int(a[a.index('-S') + 1])
        print(cap(e, sc))
    elif c == 'keys': keys(a[0], a[1:])
    elif c == 'lit': tmux('send-keys', '-t', SOCK, '-l', a[1]); settle(0.5); save(a[0])
    elif c == 'cmd':
        tmux('send-keys', '-t', SOCK, '-l', a[1]); time.sleep(0.6)
        tmux('send-keys', '-t', SOCK, 'Enter'); settle(1.2, 20); save(a[0])
    elif c == 'perf': perf(a[0], int(a[1]), a[2] if len(a) > 2 else 'Tab')
    elif c == 'kill': tmux('kill-server'); print('killed')
