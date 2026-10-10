#!/bin/bash
# usage: setup.sh <scratch-dir>   builds cfg, proj, out and reply.txt (same as the first run)
S="$1"; rm -rf "$S"; mkdir -p "$S/cfg" "$S/proj" "$S/out"
echo '{"hasCompletedOnboarding": true}' > "$S/cfg/.claude.json"
cd "$S/proj" && git init -q . && git remote add origin git@github.com:cli/cli.git
printf '%s\n' 'Here is what I found. The fix is in https://github.com/cli/cli/pull/14640 and the discussion is in [the plugin docs](https://code.claude.com/docs/en/plugins). The Jira ticket https://example.atlassian.net/browse/DEMO-1 tracks it.' > "$S/reply.txt"
echo ok
