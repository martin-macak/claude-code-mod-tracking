# Spikes, 2026-10-21

Source files and captures of the probe mod behind the page [questions-and-plans](../../concepts/questions-and-plans.md). It ran for [issue #71](https://github.com/martin-macak/claude-code-mod-tracking/issues/71) on Claude Code **2.1.306** (the types snapshot is 2.1.302), macOS, on 2026-10-21. It answers one question: what does a `tool.call` hook see of an `AskUserQuestion` call and of an `ExitPlanMode` call, before the dialog and after it?

This folder is evidence, not product. It is a snapshot: do not edit it.

## What is here

| Path | What it is |
| --- | --- |
| `questions-probe/` | The probe mod. One `tool.call` hook writes `e` and the answer of `next(e)` of each `AskUserQuestion`, `ExitPlanMode` and `EnterPlanMode` call to a file. |
| `fake-api.mjs` | A local Messages API. It plays the turns of a sequence file and answers a request with no tools (the session title) with a fixed text, so it takes no turn. `{{PLAN_PATH}}` in a turn becomes the plan file path that plan mode names in the request. |
| `seq-*.json` | The turns of each run: a `tool_use` of `AskUserQuestion` or `ExitPlanMode`, with a `Write` of the plan file before the second kind. |
| `drive/launch.sh`, `drive/start.sh` | Start `claude` against the fake API with an empty config dir and the probe mod, in tmux, and move past the trust dialog. |
| `captures/*.json` | What the hook wrote: `input` is the `e` of the hook, `ran` the answer of `next(e)`, `threw` the text of a throw. |

`<SPIKES>` stands for the folder that held all of these. Set it to a folder of your own before you run a spike. A `--plugin-dir` folder is watched, so keep the output folder outside `questions-probe/`, or the mod reloads at every write.

## How a run went

1. `node fake-api.mjs` with `PORT`, `SEQ` (a sequence file) and `LOG` set.
2. `drive/start.sh <port> <name> [claude args]` starts the session in a tmux window of 120 by 40 on its own socket. Plan mode needs `--permission-mode plan`.
3. Type a prompt and press Enter. The fake model answers with the `tool_use`. The dialog opens. The keys that answered it are in the table below.
4. Read the file in `captures/`.

The runs used the real `claude` binary with a fake token (`ANTHROPIC_AUTH_TOKEN=fake`, `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`), `CLAUDE_CONFIG_DIR` set to an empty folder, and every `CLAUDE_CODE_*` variable of the parent session removed. No model and no account were used. The machine has managed settings, so the guard `cc-plugin-sec-default` loaded as usual.

## Runs

Grade: *verified-live* (an interactive session in tmux, a fake API behind it).

| Run | Sequence | Keys | Capture |
| --- | --- | --- | --- |
| R1 | `seq-ask.json`: two questions, the first with a preview, the second a multi-select with a label that holds a comma | `n`, text, Enter on question 1 (notes, no option); Enter, Down, Enter, Down, Down, Enter, text, Down, Enter on question 2 (two options and typed text); Enter on `Submit answers` | `captures/AskUserQuestion-toolu_ask_1.json` |
| R2 | `seq-ask-esc.json`, first turn | Esc | `captures/AskUserQuestion-toolu_ask_esc.json` |
| R3 | `seq-ask-esc.json`, second turn: one question, one pick | Enter on the first option | `captures/AskUserQuestion-toolu_ask_one.json` |
| R4 | `seq-plan.json`: `ExitPlanMode` with no plan file | Enter on `1. Yes, and switch to default` | `captures/ExitPlanMode-toolu_plan_1.json` |
| R5 | `seq-plan-file.json`: a `Write` of the plan file, then `ExitPlanMode` | `2` (`Yes, manually approve edits`) | `captures/ExitPlanMode-toolu_plan_2.json` |
| R6 | `seq-plan-reject.json`, second turn | `3` (`Tell Claude what to change`), text, Enter | `captures/ExitPlanMode-toolu_plan_reject.json` |
| R7 | `seq-plan-reject.json`, third turn | Esc | `captures/ExitPlanMode-toolu_plan_esc.json` |

The engine runs a title request with no tools before the first turn. A fake API that answers it from the sequence loses the first turn: `fake-api.mjs` answers it apart.
