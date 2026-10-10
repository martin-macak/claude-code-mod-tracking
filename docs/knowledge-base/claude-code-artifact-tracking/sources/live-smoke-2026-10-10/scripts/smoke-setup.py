import os, subprocess, json, shutil
S = '<scratch>/smoke'
shutil.rmtree(S, ignore_errors=True)
for d in ('cfg', 'proj', 'out'):
    os.makedirs(f'{S}/{d}')
json.dump({'hasCompletedOnboarding': True}, open(f'{S}/cfg/.claude.json', 'w'))
subprocess.run(['git', 'init', '-q', '.'], cwd=f'{S}/proj', check=True)
subprocess.run(['git', 'remote', 'add', 'origin', 'git@github.com:cli/cli.git'], cwd=f'{S}/proj', check=True)
open(f'{S}/reply.txt', 'w').write(
    'Here is what I found. The fix is in https://github.com/cli/cli/pull/14640 and the discussion is in '
    '[the plugin docs](https://code.claude.com/docs/en/plugins). The Jira ticket https://example.atlassian.net/browse/DEMO-1 tracks it.\n')
print('ok')
