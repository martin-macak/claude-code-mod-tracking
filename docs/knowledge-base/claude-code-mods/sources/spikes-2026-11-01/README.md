# Spikes, 2026-11-01

Probes and captures for [issue #208](https://github.com/martin-macak/claude-code-mod-tracking/issues/208): the question forms that no run had shown. Claude Code **2.1.316**, macOS, a fake Messages API behind a real session in tmux (no model, no login). The page is [questions-and-plans](../../concepts/questions-and-plans.md#the-forms-that-ran-live-issue-208).

This folder is evidence, not product. It is a snapshot: do not edit it. `<SPIKES>` stands for the folder that held the files and `<MOD>` for `plugins/artifact-tracking`. Set both before you run a spike. Keep the output folder outside the probe folders: a plugin folder is watched.

## What is here

| Path | What it is |
| --- | --- |
| `capture-probe/` | One `tool.call` hook. It writes `e` and the answer of `next(e)` of each `AskUserQuestion` call to `<SPIKES>/out/`. |
| `asker-probe/` | Registers `/askme`. The command calls `$.ui.ask('Which colour?', { options: ['Red', 'Blue'] })` and logs the answer. |
| `fake-api.mjs` | The fake API of the 2026-10-21 spike. This copy also writes the `AskUserQuestion` tool schema that the engine sent (`SCHEMA=<file>`). |
| `seq-all.json` | Four calls in a row: text and number, a label with a comma, a typed piece with a quote and a comma, a single pick (for `Chat about this`). |
| `seq-more.json` | A quote with no comma, a backslash, a single typed answer with a quote and a comma. |
| `seq-afk.json` | One single pick, left alone. |
| `launch.sh`, `start.sh`, `run.sh`, `drive-all.sh` | Start the fake API and `claude` in tmux (socket `i208spike`), and send the keys of `seq-all.json`. |
| `captures/` | The hook's files, the two tool schemas, `asker.log`, and two `/track qa` screens. |

## Runs

| Run | How | Keys | Capture |
| --- | --- | --- | --- |
| T1 | `XENV="CLAUDE_CODE_ENTRYPOINT=sdk-cli CLAUDE_CODE_QUESTION_EXTENDED=1" run.sh seq-all.json all` | text, Enter, number, Enter, Enter | `toolu_tn_1` |
| T0 | The same sequence without `XENV` | none: the engine refuses `kind` and needs `options` | schema in the request log (no `kind` property) |
| C2 | same session, second call | Enter on `A`, Down, Enter on `A, custom`, Down, Down, text, Down, Enter, Enter | `toolu_comma_1` |
| C3 | same session, third call | Enter on `Lint`, Down, Down, text `say "hi", ok`, Down, Enter, Enter | `toolu_quote_1` |
| C4 | `run.sh seq-more.json more`, then `go` | per question: Enter on `Lint`, Down, Down, text, Down, Enter | `toolu_more_1` |
| Chat | same session as T1, fourth call | Down x3 (the fourth row `Chat about this`), Enter | `toolu_chat_1` |
| AFK | `XENV="CLAUDE_AFK_TIMEOUT_MS=8000" run.sh seq-afk.json afk`, then `go` | none: wait | `toolu_afk_1` |
| Ask | `run.sh seq-afk.json ask`, then `/askme` | Down, Enter on `Blue`, then `/track qa` | `toolu_plugin_…`, `asker.log` |

`XENV` is a list of `NAME=value` words that `launch.sh` puts in the environment of `claude`. `track-qa-before-fix.txt` is the screen of `/track qa` with the mod before the fix of `parse.ts`; `track-qa-1-text-number.txt` is the screen of `/track qa 1` for the text and number call.
