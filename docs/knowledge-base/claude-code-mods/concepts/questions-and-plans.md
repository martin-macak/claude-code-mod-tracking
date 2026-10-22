# Questions and plans as a hook sees them (issue #71)

Date: 2026-10-21. Engine: Claude Code 2.1.306 (the types snapshot is 2.1.302).

This page records what a `tool.call` hook sees of an `AskUserQuestion` call and of an `ExitPlanMode` call: before the dialog opens, and after the person answered. The spike of [issue #71](https://github.com/martin-macak/claude-code-mod-tracking/issues/71) first ran on 2.1.302 with a fake Messages API (the issue holds its summary). The runs below repeated it on 2.1.306 and added the plan dialog. The probe mod, the fake API, the keys and every capture are in [sources/spikes-2026-10-21](../sources/spikes-2026-10-21/README.md).

## Grades

| Tag | Meaning | KB grade |
| --- | --- | --- |
| `[observed]` | Seen in a capture of a run in a tmux session, with a fake API behind the engine (no model, no account) | *verified-live* (an interactive session). The fake API means the model was not real. |
| `[primary source]` | Stated by the types file | *types-only* |
| `[inference]` | Nobody ran it | *inference* |

## What the hook sees

One `tool.call` hook (`tool: 'AskUserQuestion'` or `'ExitPlanMode'`) calls `await next(e)` and then reads the answer. `e` is the whole input. The answer of `next(e)` has the shape `{ ref, result, text, isError?, isReadOnly? }` ([d.ts:13340](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13340)), or `{ deny }` when a hook denied the call. `result` is the tool's own record: the output schema is at [d.ts:21094](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21094) for `AskUserQuestion` and [d.ts:21370](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21370) for `ExitPlanMode`. The `text` is what the model reads. It is not a contract: the two answered runs gave `The user answered: …` (R1) and `Your questions have been answered: …` (R3) for the same shape of record.

### AskUserQuestion

| Fact | Evidence | Tag |
| --- | --- | --- |
| Before the dialog, `e` holds `questions[]` (`question`, `header`, `multiSelect`, `options[]` with `label`, `description`, optional `preview`), `tool` and `tool_use_id`. | R1 `input` | `[observed]` |
| After the dialog, `result` is `{ questions, answers, annotations }`. `answers` maps the question text to a string. `annotations` maps the question text to `{ preview?, notes? }`, and is `{}` when there is none. | R1, R3 | `[observed]` |
| A pick is the label: `"Ship it?": "Yes"`. A text typed under "Other" is the text as typed. | R3 (pick), R1 (typed) | `[observed]` |
| A multi-select answer is one string. The labels are joined with a comma and a space, and a piece that holds a comma is wrapped in double quotes: `Lint, "Tests, all", "typed, with comma"`. The typed text is a piece like any other: only the options of the question tell a label from typed text. | R1 | `[observed]` |
| Notes with no option picked give the answer `(notes only)` and an annotation `{ notes }`. The question is not missing from `answers`. | R1 | `[observed]` |
| A question the person leaves blank is missing from `answers` (the 2.1.302 run of the issue). This run did not leave one blank. | issue #71, evidence | `[observed]` on 2.1.302 |
| The picked preview comes in `annotations[question].preview`. | issue #71, evidence. R1 had notes and no pick, so it shows none. | `[observed]` on 2.1.302 |
| Esc is `isError: true`. `result` is the string `Error: The user doesn't want to proceed with this tool use. …`, and `text` is the same without `Error:`. The turn ended: no further model request followed. | R2 | `[observed]` |
| `result` is typed `answers: {}`, `annotations: {}`: the output schema does not describe the keys. The `response`, `followUp` (a request for another round) and `afkTimeoutMs` (an away dialog) fields are in the schema. None was run. | [d.ts:21129-21138](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21129-L21138) | `[primary source]` |
| The output schema has `kind` (`choice`, `text`, `number`) and `description` for a question. No run asked one. | [d.ts:21101-21103](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21101-L21103) | `[primary source]` |
| A `$.ui.ask` of another plugin reaches the same hook with an id `toolu_plugin_…`. The event does not name the plugin. | [d.ts:2452](../sources/claude-code-2.1.302/types/claude-code.d.ts#L2452), issue #71 | `[primary source]` |

### ExitPlanMode

| Fact | Evidence | Tag |
| --- | --- | --- |
| The input `e` holds `plan` (the whole plan text) and `planFilePath` before the dialog, when the model wrote a plan file. The engine puts them in: the model sent `{}`. With no plan file, `e` has neither. | R5, R4 | `[observed]` |
| An approval is a result `{ plan, isAgent: false, filePath }` with no `isError`. `plan` is the text again, or `null` with no plan file. The `text` starts `User has approved your plan.` and repeats the plan under `## Approved Plan:`. With no plan file it reads `User has approved exiting plan mode.` | R5, R4 | `[observed]` |
| The way the person approved (auto mode, manual edits, the default mode) is not in the result. | R4, R5 | `[observed]` |
| A rejection with a note (`Tell Claude what to change`) is `isError: true`. `result` and `text` hold the engine's words and the note: `… To tell you how to proceed, the user said:\nUse fewer steps`. The note is in those strings only. | R6 | `[observed]` |
| Esc on the plan dialog is `isError: true` and the words `… STOP what you are doing and wait for the user to tell you how to proceed.` | R7 | `[observed]` |
| The input keeps the plan on a rejection too (`plan` and `planFilePath` are there before the dialog), so a hook has the plan whatever the outcome. | R6, R7 | `[observed]` |
| `awaitingLeaderApproval` and `requestId` are in the output schema for a teammate that sends its plan to a leader. No run asked one. | [d.ts:21380-21383](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21380-L21383) | `[primary source]` |
| `planWasEdited` (an edit with `Ctrl+G` or on the web) is in the schema. Not run. | [d.ts:21378](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21378) | `[primary source]` |

So a hook sees both the plan and the outcome. The outcome is `isError`. The plan is in the input. The note of a rejection is in the string `result` and in the `text`: the capture of the rejected plan (R6) shows both, so the text is not needed for it.

## After `--resume`

`$.session.messages()` returns each tool use as `{ tool_use_id, tool, input, result?, text?, isError? }` ([d.ts:13810](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13810)). `input` is "the arguments the model gave it" and `result` is "what the transcript stored": the tool record on an answered call, the error text on a refused one. So the replay of an answered `AskUserQuestion` has the same structured answer, and the replay of an approved plan has the plan in `result.plan` and none in `input`. The replay of a rejected plan has the error text and no plan. A `$.ui.ask` of another plugin is not in the transcript (issue #71). The replay is `[primary source]` here: the mod's tests drive it with a fake transcript, no run read a real one.

The mod keeps its caps (100 calls, 256 KiB) across a resume, so the replay must tell a call that the caps dropped from a call that the mod never saw. The ids of the stored calls say it, but only while the stored copy holds a call of the transcript: the caps can leave only plugin calls or a subagent's calls, which the transcript of the main loop lacks, and then no id matches. A replay that took this for a cold load would add every dropped call after the newer ones, and the caps would then evict the newer ones. So a drop leaves the id of the newest dropped transcript call on the first call that stays (`watermark` in the record). It moves on as that call drops. The replay reads the transcript only after the later of two marks: the first stored call it finds, and the watermark. A stored copy with neither has seen no transcript call drop, so the replay adds all of them. A copy that came over `/clear` carries a watermark that the new transcript lacks, so it adds all of them too. Grade: *verified-kit*. The kit tests drive this with a fake transcript (`questions-tracker` "a resume whose stored copy holds only plugin calls…"). `[inference]`: no run resumed a real session past the caps.

## Not tested

- "Chat about this" (`followUp`, `response`) and the answer of an away dialog (`afkTimeoutMs`).
- A `text` or `number` question (`kind`). The mod keeps `placeholder`, `min`, `max`, `step`, `defaultValue` and `unit` of such a question as the output schema names them ([d.ts:21116](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21116)) `[primary source]`. No run has shown them, and the shape of the answer to such a question is not seen either ([issue #208](https://github.com/martin-macak/claude-code-mod-tracking/issues/208)).
- A `$.ui.ask` of a real second plugin, and which field would name it.
- An edit of a plan with `Ctrl+G` (or on the web), and a teammate plan that awaits its leader. The mod reads an approved plan from `result.plan` first and from the input second, so an edited plan shows when the result carries it `[inference]`. In every capture the two are equal. The live check of an edit is [issue #208](https://github.com/martin-macak/claude-code-mod-tracking/issues/208).
- The copy of a call to the clipboard: the mod calls `ui.copy` ([d.ts:2593](../sources/claude-code-2.1.302/types/claude-code.d.ts#L2593)). The kit checks the call and the text. A live run (2.1.307) heard the event in a probe plugin that answered it without `next`, so the text of the key is proven and the clipboard stayed as it was `[observed]`. No run let the engine write the clipboard, because that would overwrite it (open question 49).
- Any version but 2.1.302 and 2.1.306.

## What the mod does with it

[`trackers/questions/`](../../../../plugins/artifact-tracking/trackers/questions/) reads `result.result` and never the text, except for the pieces of a multi-select answer. The words of a refusal, with the note of a rejected plan, are the string `result.result` (it keeps the engine's `Error:` mark). The text is the fallback for a transcript use that stored no `result`. See the README section [Questions and answers](../../../../plugins/artifact-tracking/README.md#questions-and-answers).
