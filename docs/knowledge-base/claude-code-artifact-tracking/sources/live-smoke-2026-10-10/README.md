# Live smoke run of the artifact-tracking mod, 2026-10-10

One real run of `plugins/artifact-tracking` in Claude Code 2.1.296 (`claude` on PATH). It shows the mod working outside the test kit: capture, refresh with the real `gh` and `acli`, `/track`, the pane, the band, and `/clear`.

## Safety

- No real model account. The model is the KB fake API: [`fake-api.mjs`](../../../claude-code-link-capture/sources/live-observations-2026-10-10/fake-api.mjs) on `127.0.0.1:8811`. It answers every request with one fixed text (see "Fixed reply").
- `ANTHROPIC_BASE_URL=http://127.0.0.1:8811`, `ANTHROPIC_AUTH_TOKEN=fake`, an empty `CLAUDE_CONFIG_DIR`. Every `CLAUDE_CODE_*` variable is removed from the child environment. [`outputs/00-env.txt`](outputs/00-env.txt) counts 0 left. The pty script asserts it.
- Real tools, read-only calls only: `gh --version`, one GraphQL read `query` on two public `cli/cli` items, `acli --version`, `acli jira auth status`. The mod made no write call. The Jira key `DEMO-1` is on `example.atlassian.net`, which is not the active site. So the mod made no `acli` call about it.
- Redaction: scratch folder `<scratch>`, repo `<repo>`, home `~`, user name `<user>`, the active Jira site `<site>.atlassian.net`. The raw pty bytes are not saved. `40-repl-clear-text.txt` is their text with escape codes removed.

## Setup

| Item | Value |
| --- | --- |
| Project folder | A fresh `git init` with `origin` set to `git@github.com:cli/cli.git`. So `$.session.repo()` gives `cli/cli`, and a bare `#14622` means `cli/cli#14622`. |
| Fixed reply | `Here is what I found. The fix is in https://github.com/cli/cli/pull/14640 and the discussion is in [the plugin docs](https://code.claude.com/docs/en/plugins). The Jira ticket https://example.atlassian.net/browse/DEMO-1 tracks it.` |
| Prompt | `Please check #14622 and tell me where the fix is.` |
| `gh` | 2.102.0, logged in on this machine. Items: `cli/cli#14622` (issue), `cli/cli#14640` (PR). |
| `acli` | 1.3.19-stable, logged in to one site. |
| Mod | `--plugin-dir plugins/artifact-tracking`. |

[`scripts/`](scripts/) holds the three scripts used. `smoke-setup.py` builds the folders. `run-p.sh` does the headless runs. `pty-run.py` is the KB pty script, adapted (port, no `CLAUDE_CODE_*`, Esc key).

## Headless runs (`claude -p`)

| File | Command | What it shows |
| --- | --- | --- |
| [`10-run1-prompt.txt`](outputs/10-run1-prompt.txt) | `claude -p --plugin-dir … "Please check #14622 …"` | The fake reply. The first line is a gateway notice of Claude Code, not of the mod. |
| [`20-run2-track.txt`](outputs/20-run2-track.txt) | `claude -p --plugin-dir … --continue "/track"` | `/track` lists all four items from the earlier session. The sections say `acli · ready` and `gh · ready`, not "checking". The statuses are still empty, because bare `/track` starts the refresh in the background and `-p` ends first. |
| [`30-run3-track-refresh.txt`](outputs/30-run3-track-refresh.txt) | `claude -p --plugin-dir … --continue "/track refresh"` | `/track refresh` waits for the refresh. The real `gh` filled both items: `cli/cli#14622` closed, `cli/cli#14640` open with failing checks. `DEMO-1` shows `track-only`, because its site is not the active site. The web link has no status. |
| [`50-store-after-headless-runs.json`](outputs/50-store-after-headless-runs.json) | | The `$.store` copy after run 3 (written by run 3 only): plain records with the refreshed fields. No raw CLI output. |
| [`60-debug-run*.txt`](outputs/) | `--debug-file`, lines with the plugin name | Each hook and each `$.process.run` call. |

How run 2 got its items: `--continue` keeps the session id. Run 1 and run 2 ended before the 1.5 s store flush: `grep -c store.set outputs/60-debug-run*.txt` gives 0, 0 and 2 for runs 1, 2 and 3. So the `$.store` was empty at the start of run 2, and run 2 rebuilt its list from the transcript (`$.session.messages()` backfill): the prompt gave `#14622`, the reply gave the PR, the web link and the Jira key. Run 3 did the same, refreshed, and its flush wrote [`50-store-after-headless-runs.json`](outputs/50-store-after-headless-runs.json). The restore from a stored copy has kit tests (`tests/register.test.tsx`) and no live headless run.

## REPL run with a real `/clear` (pty)

Command: `pty-run.py <out> <project> 'Please check #14622 and tell me where the fix is.|/track|\x1b|/clear|/track|\x1b' --plugin-dir …`. The REPL ran in a 50 x 140 pseudo terminal. Files: [`40-repl-clear-text.txt`](outputs/40-repl-clear-text.txt) (the screen text, one cell group per line) and [`61-debug-repl.txt`](outputs/61-debug-repl.txt).

What the run showed:

1. **Band.** After the reply, the line `tracking  Jira 1 · GitHub 2 (1 ✗) · Links 1  /track` sat above the prompt.
2. **Pane.** `/track` opened the pane. It showed three sections with the real titles, `track-only` for `DEMO-1`, `closed` and `open ✗ checks` for the two GitHub items, and the web link. The header `GitHub  gh · refreshed 7s ago` appeared after the refresh finished. The pane redrew by itself.
3. **Esc.** The `ui.close` hook ran for both Esc presses (`61-debug-repl.txt`, "ui.close settled").
4. **Real `/clear`.** `/clear` reset `$.state` and gave a new session id (the second `$.store.set` key differs from the first). The next `/track` listed the same items again, with their statuses and the refresh age (`refreshed 23s ago`). So the carry-over from `s:<old id>` works with a real reset. This is the case the kit cannot test.
5. **No transient state after `/clear`.** `/track` waits for the tool probes and the session repo before it opens the pane. So the first drawing after `/clear` already says `ready` and `refreshed 23s ago`, and the keys read `#14622`. The text `checking` appears nowhere in the capture (`grep -c checking outputs/40-repl-clear-text.txt` gives 0). An earlier run, before `/track` got this order, drew `acli · checking…`, `gh · checking…` and the long key `cli/cli#14622` for a moment after `/clear`.

## Not covered

- The tick while the pane is open. The run was shorter than the 30 s tick. The kit test covers the tick with a fake clock.
- Jira refresh on the active site. Using the real Jira account would read a real work item. The kit tests cover it with fixtures.
- GitHub Enterprise.
- Resize, the narrow-pane layout, and the desktop surface.

Rerun at `2d1ea8d` (the review fixes): see [`rerun-2d1ea8d/`](rerun-2d1ea8d/README.md).
