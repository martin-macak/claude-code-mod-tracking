import os, pty, sys, time, select, struct, fcntl, termios, json, re
# usage: pty-steps.py <outfile> <cwd> <steps.json> [claude args...]
# steps: ["wait:8", "type:/probe-run", "enter", "touch:<path>", "sample:<file>", "ctrlc"]
out, cwd, steps_file = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4:]
SP = os.environ['SP']
cfg = SP + '/cfg'
cj = cfg + '/.claude.json'
d = json.load(open(cj)) if os.path.exists(cj) else {}
d['hasCompletedOnboarding'] = True
d.setdefault('projects', {})[cwd] = {'hasTrustDialogAccepted': True, 'allowedTools': []}
json.dump(d, open(cj, 'w'))
env = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE_CODE_') and k not in ('CLAUDECODE', 'CLAUDE_CONFIG_DIR')}
env.update(CLAUDE_CONFIG_DIR=cfg, ANTHROPIC_BASE_URL='http://127.0.0.1:8799', ANTHROPIC_AUTH_TOKEN='fake',
           FORCE_HYPERLINK='1', TERM='xterm-256color', COLORTERM='truecolor', CLAUDE_CODE_NO_FLICKER='0',
           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
claude = os.environ.get('CLAUDE_BIN') or os.path.expanduser('~/.local/share/claude/versions/2.1.295')
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execve(claude, [claude] + extra, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', int(os.environ.get('ROWS', 50)), int(os.environ.get('COLS', 140)), 0, 0))
buf = b''
marks = []
timeline = []
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return False
            if not data: return False
            buf += data
t0 = time.time()
for st in json.load(open(steps_file)):
    k, _, a = st.partition(':')
    marks.append((round(time.time() - t0, 1), len(buf), st))
    try:
        if k == 'wait': pump(float(a))
        elif k == 'type': os.write(fd, a.encode()); pump(1)
        elif k == 'enter': os.write(fd, b'\r'); pump(1)
        elif k == 'ctrlc': os.write(fd, b'\x03'); pump(1)
        elif k == 'touch':
            with open(a, 'a') as f: f.write('\n// touched ' + str(time.time()) + '\n')
            pump(1)
        elif k == 'sample':
            try: timeline.append((round(time.time() - t0, 1), open(a).read()))
            except Exception as ex: timeline.append((round(time.time() - t0, 1), 'ERR ' + str(ex)))
            pump(0.1)
    except OSError as ex:
        print('child gone', ex); break
try: os.kill(pid, 9)
except Exception: pass
open(out, 'wb').write(buf)
json.dump({'marks': marks, 'timeline': timeline}, open(out + '.meta.json', 'w'), indent=1)
print(len(buf), 'bytes')
