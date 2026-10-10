import os, pty, sys, time, select, struct, fcntl, termios, json, subprocess
# Run Claude Code 2.1.295 in a pseudo terminal against the fake API and save the raw bytes it writes.
# usage: CFG_DIR=<empty dir> pty-run.py <outfile> <cwd> '<prompt>|<prompt>|...' [extra claude args...]
# FORCE_HYPERLINK=1 makes the renderer draw OSC 8. Do not pass --permission-mode bypassPermissions (it opens a dialog).
out, cwd, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4:]
here = os.path.dirname(os.path.abspath(__file__))
cfg = os.environ.get('CFG_DIR') or os.path.join(here, 'cfg')
cj = os.path.join(cfg, '.claude.json')
d = json.load(open(cj)) if os.path.exists(cj) else {}
d['hasCompletedOnboarding'] = True
d.setdefault('projects', {})[cwd] = {'hasTrustDialogAccepted': True, 'allowedTools': []}
json.dump(d, open(cj, 'w'))
env = {k:v for k,v in os.environ.items() if not k.startswith('CLAUDE_CODE_') and k not in ('CLAUDECODE','CLAUDE_CONFIG_DIR')}
env.update(CLAUDE_CONFIG_DIR=cfg, ANTHROPIC_BASE_URL='http://127.0.0.1:8799', ANTHROPIC_AUTH_TOKEN='fake',
           FORCE_HYPERLINK='1', TERM='xterm-256color', COLORTERM='truecolor', CLAUDE_CODE_NO_FLICKER='0',
           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
claude = os.environ.get('CLAUDE_BIN') or os.path.expanduser('~/.local/share/claude/versions/2.1.295')
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execve(claude, [claude] + extra, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 140, 0, 0))
buf = b''
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
    return True
pump(8)
try:
  for k, p in enumerate(prompt.split('|')):
    os.write(fd, p.encode()); pump(1)
    os.write(fd, b'\r'); pump(8 if k == 0 else 4)
except OSError as ex:
  print('child gone', ex)
try:
  os.write(fd, b'\x03'); pump(1); os.write(fd, b'\x03'); pump(2)
except OSError: pass
try: os.kill(pid, 9)
except Exception: pass
open(out, 'wb').write(buf)
print(len(buf), 'bytes')
