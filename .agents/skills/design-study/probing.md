# Probing Claude Code with a fake API

A probe answers a spike with a run. It needs no model and no login: a fake Messages API plays a fixed list of tool calls, and a probe mod logs what the hooks see.

A working copy lives in `docs/knowledge-base/claude-code-auto-tracking/sources/live-probe-2026-10-10/`: `register.ts` (probe mod), `repro/fake2.mjs` (fake API), `repro/run.sh` (launcher). Copy them to the scratchpad. Never edit files under `sources/`.

## Parts

1. **Probe mod.** A plugin folder with `.claude-plugin/plugin.json`, `hooks/hooks.json` (`{ "modules": ["./register.ts"] }`) and `hooks/register.ts`. Log one JSON line per event to a scratchpad file. Log what the spike needs: `tool.call` input and `result` (also `isError` and `text`), every `session.append` with `door`, `origin` and content, `session.start`, `session.end`. Time each `$.process.run` you test. Run `claude plugin validate <dir>` first.
2. **Fake API.** A Node HTTP server on `127.0.0.1`. For each streamed request it answers the next turn of a JSON script: `[[{ "type": "tool_use", "name": "Bash", "input": {…} }], [{ "type": "text", "text": "done" }]]`. Add spare text turns at the end: notifications start extra requests. When a turn needs an id from an earlier tool result (a task id for `TaskStop`), fill it from the request body with a regex.
3. **Launcher.** Run Claude with a clean environment:

   ```bash
   env -u CLAUDECODE -u CLAUDE_CONFIG_DIR $(env | grep -o '^CLAUDE_CODE_[A-Z_]*' | sed 's/^/-u /') \
     CLAUDE_CONFIG_DIR=<scratch>/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:8799 ANTHROPIC_AUTH_TOKEN=fake \
     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
     perl -e 'alarm 120; exec @ARGV' claude -p "run the probe" \
       --plugin-dir <scratch>/probe --permission-mode bypassPermissions --output-format json
   ```

## Interactive runs

Some behavior exists only in the TUI (Ctrl+B, idle notifications, exit dialogs).

- Use a private tmux server: `tmux -L <name> -f /dev/null new-session -d -s tui -x 160 -y 45 <launcher>`. Never use the default socket: the user's sessions live there.
- In `<scratch>/cfg/.claude.json`, set `hasCompletedOnboarding: true`, `theme`, and `projects.<cwd>.hasTrustDialogAccepted: true`. Use both the real path (`pwd -P`) and the `/tmp` path.
- The bypass-mode warning selects "No, exit" first. Send `Down`, then `Enter`.
- Read the screen with `tmux -L <name> capture-pane -p -t tui`. Send keys with `send-keys`.

## Known behavior (Claude Code 2.1.296)

- `-p` waits for running background shells before it exits. Set an alarm.
- The Monitor and Artifact tools are disabled under a fake API.
- A failed tool call gives `result` as a string and `isError: true`.
- Notifications come on more than one `session.append` door. Match on `origin`.

## Safety and cleanup

- Work only in the scratchpad and a throwaway git repo. Use names with a `probe` prefix for containers, sessions and files.
- Before you finish, list what the probe started (`docker ps -a --filter name=probe`, `tmux ls`, `screen -ls`, `ps`), remove only those items, then list again.
- Stop the fake API.
- Before you save the logs to `docs/knowledge-base/<slug>/sources/<probe>-<date>/`: drop request logs and `append.attachment` rows (they hold the system prompt), and replace the user name, the e-mail address and the org name.
