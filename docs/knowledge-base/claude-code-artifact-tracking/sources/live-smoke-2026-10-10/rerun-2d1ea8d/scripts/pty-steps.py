import shutil, os, pty, sys, time, select, struct, fcntl, termios, json, datetime
import pyte
# Run Claude Code in a pseudo terminal against the fake API and follow a list of steps.
# Screens are rendered with pyte, so a snapshot shows what the person sees at that moment.
# usage: CFG_DIR=<empty dir> PORT=<fake api port> pty-steps.py <outprefix> <cwd> <steps.json> [claude args...]
# steps: "wait:SECONDS", "type:TEXT", "enter", "esc", "ctrlc", "mark:NAME", "snap:NAME", "waitfor:TEXT:TIMEOUT"
# Every step is logged with a UTC time (ms), to compare with the lines of --debug-file.
out, cwd, steps_file = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4:]
cfg = os.environ['CFG_DIR']
port = os.environ.get('PORT', '8811')
ROWS, COLS = 50, 140
cj = os.path.join(cfg, '.claude.json')
d = json.load(open(cj)) if os.path.exists(cj) else {}
d['hasCompletedOnboarding'] = True
d.setdefault('projects', {})[cwd] = {'hasTrustDialogAccepted': True, 'allowedTools': []}
json.dump(d, open(cj, 'w'))
env = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE_CODE_') and k not in ('CLAUDECODE', 'CLAUDE_CONFIG_DIR')}
env.update(CLAUDE_CONFIG_DIR=cfg, ANTHROPIC_BASE_URL='http://127.0.0.1:' + port, ANTHROPIC_AUTH_TOKEN='fake',
           FORCE_HYPERLINK='1', TERM='xterm-256color', COLORTERM='truecolor', DISABLE_AUTOUPDATER='1')
assert not [k for k in env if k.startswith('CLAUDE_CODE_')]
claude = os.environ.get('CLAUDE_BIN') or shutil.which('claude')
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execve(claude, [claude] + extra, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
log = []
def now(): return datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S.%f')[:-3]
def text(): return '\n'.join(l.rstrip() for l in screen.display).rstrip()
def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return False
            if not data: return False
            stream.feed(data)
    return True
snaps = []
t0 = time.time()
try:
    for st in json.load(open(steps_file)):
        k, _, a = st.partition(':')
        log.append(f'{now()} +{time.time()-t0:6.1f}s {st}')
        if k == 'wait': pump(float(a))
        elif k == 'type': os.write(fd, a.encode()); pump(0.05)
        elif k == 'enter': os.write(fd, b'\r'); pump(0.05)
        elif k == 'esc': os.write(fd, b'\x1b'); pump(0.05)
        elif k == 'ctrlc': os.write(fd, b'\x03'); pump(0.05)
        elif k == 'mark': pass
        elif k == 'snap':
            pump(0.3)
            snaps.append(f'===== snap {a}  at {now()} (+{time.time()-t0:.1f}s)\n{text()}\n')
        elif k == 'waitfor':
            needle, _, to = a.rpartition(':')
            end = time.time() + float(to)
            while needle not in text() and time.time() < end: pump(0.05)
            log.append(f'{now()}   waitfor {needle!r}: {"found" if needle in text() else "TIMEOUT"}')
except OSError as ex:
    log.append(f'child gone {ex}')
try:
    os.write(fd, b'\x03'); pump(1); os.write(fd, b'\x03'); pump(1)
except OSError: pass
try: os.kill(pid, 9)
except Exception: pass
open(out + '-snaps.txt', 'w').write('\n'.join(snaps))
open(out + '-steps.log', 'w').write('\n'.join(log) + '\n')
print('done', len(snaps), 'snaps')
