# Spikes, 2026-11-05

Probes and captures for [issue #312](https://github.com/martin-macak/claude-code-mod-tracking/issues/312): the question forms that need a host other than the terminal. Claude Code **2.1.318**, macOS, a real model (`--model haiku`) and the person's login, with the real mod loaded from the repo. The page is [questions-and-plans](../../concepts/questions-and-plans.md#through-a-permission-prompt-host-and-ctrlg-issue-312).

This folder is evidence, not product. It is a snapshot: do not edit it. `<MOD>` stands for `plugins/artifact-tracking`. In the captures `<HOME>` is the home folder, `<CONFIG>` the Claude config folder, `<REPO>` the checkout and `<SCRATCH>` the scratch folder of the run.

## What is here

| Path | What it is |
| --- | --- |
| `host.mjs` | A permission-prompt host. It starts `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`, sends `initialize` and a prompt, and answers the `can_use_tool` control request of `AskUserQuestion` with `{ behavior: 'allow', updatedInput }`. `VARIANT` picks what `updatedInput` adds to the input. After the first `result` it sends `/track qa` as a second turn. It removes the variables of a parent session from the environment of `claude`. |
| `run-host.sh` | Runs one variant in an empty git repo with the mod and the probe. Extended (`1`) sets `CLAUDE_CODE_ENTRYPOINT=sdk-cli CLAUDE_CODE_QUESTION_EXTENDED=1`, so the questions carry `kind`. |
| `plan-probe/` | One `tool.call` hook. It writes `e` and the answer of `next(e)` of each `ExitPlanMode` and `AskUserQuestion` call. The launch scripts copy it and fill in `<OUT>`. |
| `editor.sh` | The `EDITOR` and `VISUAL` of the Ctrl+G run. It appends `EDITED-BY-SPIKE-312 marker line` to the file. |
| `launch-plan.sh` | Starts `claude --model haiku --permission-mode plan` with the mod, the probe and `editor.sh`, for tmux (socket `i312spike`). |
| `captures/` | The files below. |

## Runs

| Run | How | What the host sent beside the input | Capture |
| --- | --- | --- | --- |
| H-a | `run-host.sh a <repo> <out> 1` | `answers` (the first label), `response`, `followUp: true` | `host-a.jsonl`, `track-qa-host-a.txt` |
| H-b | `run-host.sh b <repo> <out> 1` | `annotations: { <question>: { unanswered: 'replied_in_chat' } }`, `response`, `followUp: true`, no `answers` | `host-b.jsonl`, `track-qa-host-b.txt` (before the fix), `AskUserQuestion-host-b-hook.json` (a second run with the probe), `track-qa-host-b-after-fix.txt` |
| H-c | `run-host.sh c <repo> <out> 0` | `answers`, `followUp: true`, on a question with no `kind` (stock entrypoint) | `host-c.jsonl`, `track-qa-host-c.txt` |
| H-d | `run-host.sh d <repo> <out> 1` | `answers`, `afkTimeoutMs: 5000` | `host-d.jsonl`, `track-qa-host-d.txt` |
| G | `launch-plan.sh <work> <out>` in tmux; trust the folder (Down, Enter); prompt for a three-line plan and `ExitPlanMode`; on the plan dialog press Ctrl+G; then Down, Enter (`Yes, manually approve edits`); allow the write; `/track qa` | the editor appended a marker line | `ExitPlanMode-ctrl-g.json`, `editor.log`, `track-qa-ctrl-g.txt` |

Each `host-*.jsonl` starts with one plain line, the two variables the host set. Then come the `can_use_tool` request, the answer of the host, and the `tool_result` that the model read with the structured `tool_use_result` of the same stdout line. `guard-skips.txt` holds the two `ui_log` lines of the guard in every run: it skipped the `session.append` and `prompt.compose` hooks of the mod. The `tool.call` and `command.run` hooks ran. The terminal run G showed the same two skips on the screen.
