# Live observations: mod API pieces, 2026-10-10

Not a verbatim snapshot of a source. These are a scratch mod, its inputs and its recorded outputs. [`../../mod-api-notes.md`](../../mod-api-notes.md) cites them as *observed*.

- Binary under test: `~/.local/share/claude/versions/2.1.295`. Cross-check of the process and validate results on 2.1.296 (`claude` on PATH). Both gave the same results.
- No run touched a real model or account. `ANTHROPIC_BASE_URL=http://127.0.0.1:8799`, `ANTHROPIC_AUTH_TOKEN=fake`, an empty `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_*` variables removed from the child environment. The fake API is [`fake-api.mjs`](../../../claude-code-link-capture/sources/live-observations-2026-10-10/fake-api.mjs) from the link-capture KB. The runs used slash commands only, so the model reply never mattered.
- Read-only tool use: `gh --version` and `acli --version`. No GitHub or Jira object was touched.
- Redaction: the scratch folder is `<scratch>`, the session temp folder `<session>`, the home folder `~`, the user name in a temp path `<user>`, the git remote `<owner>/<repo>`. The PATH string was never saved (only whether it equals `$.env.get('PATH')`).

## What is here

| Path | What it is |
| --- | --- |
| `probe-mod/` | The scratch mod. `hooks/register.tsx` holds every experiment as a slash command (`/probe-run`, `/probe-timers`, `/probe-timers2`, `/probe-pane`, `/probe-pane-later`, `/probe-add`, `/probe-repo`, `/probe-avail`, `/probe-globals`, `/probe-status`). `hooks/tools.ts` has no `$`: a `Run` type, an `Availability` cache class and `parseRemote`. `tests/` has 12 kit tests. The absolute output folder in `register.tsx` is redacted to `<scratch>/out/`; set your own `OUT` to rerun. |
| `validate-variants/v1..v10` | Ten small `register.ts` files for question 9. Which spellings of `$` pass `claude plugin validate`. `tools.ts` is shared. |
| `outputs/validate.<ver>.txt` | Full `claude plugin validate` output for the ten variants and the probe mod. Identical on 2.1.295 and 2.1.296 apart from the version. |
| `outputs/plugin-test.<ver>.txt` | `claude plugin test` of `probe-mod`: 12 pass, 0 fail, both versions. |
| `outputs/probe-run.<ver>.json` | `claude -p "/probe-run"`: 26 `$.process.run` / `$.session.repo` experiments with exact error text. |
| `outputs/probe-avail.txt`, `probe-globals.txt` | The injected-runner class run live; `typeof` of globals in a hooks module. |
| `outputs/timers.json`, `t2-mid.json`, `t2-end.json`, `heartbeat-timeline.txt`, `debug-excerpts.txt` | Timer experiments in a tmux REPL: callbacks that run `$.process.run` and write `$.state`, a 12 s, 11 s and 45 s callback, a throwing callback, overlapping `every` callbacks. |
| `outputs/after-clear.json`, `after-reload.json`, `before-reload.json`, `state-after-reload.json` | `$.state` after `/clear` (reset) and after a hot reload (kept). |
| `outputs/pane-open-c100.json`, `render-props-77.json`, `render-props-100.json`, `screens/` | Pane seating (an unrequested open at 100 columns), the `Pane` props at 140 and 100 columns, and screen captures of the tree table. |
| `outputs/link-osc8-excerpt.txt` | Raw bytes of a `Link` drawn in a pane. |
| `outputs/rows/`, `outputs/events/` | One file per `session.append` row, and `prompt.submit` / `command.run` events, for: a typed prompt, a user slash command with arguments, an `@file` prompt, a plugin slash command. Attachment bodies are omitted by the logger. |
| `scripts/` | `runclaude.sh` (scrubbed-env `-p` run), `tmux-run.sh` (REPL in a detached tmux server), `pty-steps.py` (REPL in a pseudo terminal; used once for the OSC 8 bytes). Paths are redacted. |

## Reproduce (outline)

```bash
# 1. fake API (any reply text), isolated config dir with onboarding done
PORT=8799 REPLY_FILE=reply.txt node ../../../claude-code-link-capture/sources/live-observations-2026-10-10/fake-api.mjs &
echo '{"hasCompletedOnboarding":true}' > cfg/.claude.json
# 2. process experiments (headless)
scripts/runclaude.sh "$PWD" -p "/probe-run" --plugin-dir probe-mod < /dev/null
# 3. timers, /clear, hot reload, pane: REPL in tmux, then send keys and read the output files
scripts/tmux-run.sh r1 140 40 "" -- --plugin-dir probe-mod
tmux -L probe send-keys -t r1 -l '/probe-timers'; tmux -L probe send-keys -t r1 Enter
```

## Limits of these observations

- Timer callbacks were tested up to 45 s. Nothing longer.
- The keyboard path into a pane (focus, Tab, Enter on a collapse `Button`) was not driven live. The kit presses the button (`ui.press`) and the redraw is checked there.
- Only the terminal surface was run live. The kit mounted the pane on `terminal` and `desktop`.
- A bare `claude` REPL was run with `--plugin-dir`. A plugin installed from a marketplace was not tried.
- Local settings on this machine seat a managed plugin (`cc-plugin-sec-default`) outermost. It did not change any result above, but a clean machine was not available.
