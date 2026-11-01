# Questions and plans as a hook sees them (issue #71)

Date: 2026-10-21 (the section "Keeping `/track qa` from the model": 2026-10-27; "The forms that ran live": 2026-11-01, Claude Code 2.1.316). Engines: Claude Code 2.1.306 (the types snapshot is 2.1.302); the section on `/track qa` ran on 2.1.310 to 2.1.312. Issues #71, #196 and #246.

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
| A multi-select answer is one string. The pieces are joined with a comma and a space, and a piece that holds a comma or a quote is a JSON string (double quotes, a backslash before an inner quote or backslash): `Lint, "Tests, all", "say \"hi\", ok"`. The typed text is a piece like any other: only the options of the question tell a label from typed text. The first run (2.1.306) saw the comma only. See [the forms that ran live](#the-forms-that-ran-live-issue-208). | R1, #208 C2 to C5 | `[observed]` |
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

## The forms that ran live (issue #208)

Issue [#208](https://github.com/martin-macak/claude-code-mod-tracking/issues/208), 2026-11-01, Claude Code **2.1.316**, macOS, tmux, a fake Messages API (no model, no login). A probe plugin wrote `e` and the answer of `next(e)` of each call. The probes, the sequences, the keys and the captures are in [spikes-2026-11-01](../sources/spikes-2026-11-01/README.md). The kit tests that use the captured shapes are in `plugins/artifact-tracking/tests/questions-live-316.test.ts`.

| # | Fact | Evidence | Tag and grade |
| --- | --- | --- | --- |
| C1 | A `text` and a `number` question answer a plain string each in `answers` (`"acme-app"`, `"12"`), with `annotations: {}`. The result keeps `kind`, `placeholder`, `min`, `max`, `step`, `defaultValue` and `unit` as given, and `options: []`. `/track qa` shows the control line and `Other (typed): …` for both. | `AskUserQuestion-toolu_tn_1.json`, `track-qa-1-text-number.txt` | `[observed]` *verified-live* |
| C1a | A terminal session does not offer these kinds. The tool schema sent to the model has no `kind`, and `options` is required (2 to 4). A `kind: "text"` call with options is drawn as a plain choice question. The kinds exist only when the host turns on `extendedQuestionsEnabled`: the engine reads `CLAUDE_CODE_QUESTION_EXTENDED` for the entrypoints `sdk-ts`, `sdk-py`, `sdk-cli`, `local-agent`, `claude-desktop`, `claude-desktop-3p`, and for a remote session. The run forced it (`CLAUDE_CODE_ENTRYPOINT=sdk-cli CLAUDE_CODE_QUESTION_EXTENDED=1`). Then a text or number question takes no options (the engine refuses them: "A "text" question takes no options"), and the terminal draws both as a text box (`Type something.`), with no slider. | `ask-tool-schema-extended.json`, engine strings of 2.1.316 | `[observed]` *verified-live* with the gate forced. A stock terminal session never asks one. |
| C2 | A multi-select with the options `A` and `A, custom` and a typed piece: the dialog's review line and the answer are `A, "A, custom", typed piece`. The engine quotes the label that holds a comma. | `…toolu_comma_1.json` | `[observed]` *verified-live* |
| C3 | A typed piece `say "hi", ok` is `Lint, "say \"hi\", ok"` in `answers`: a JSON string, a backslash before each inner quote. | `…toolu_quote_1.json` | `[observed]` *verified-live* |
| C4 | A typed piece with a quote and no comma (`a "q" b`) is quoted too (`"a \"q\" b"`). A piece with a backslash only (`c\d`) is plain. A single-select typed answer is never quoted (`x, "y"`). | `…toolu_more_1.json` | `[observed]` *verified-live* |
| C5 | The engine's own reader of this string takes a piece that starts with `"` as a JSON string and any other piece as the text up to the next `,`. A plain piece with a quote is invalid there. So a label with a comma is always quoted, and the mod's old step that joined unquoted neighbours into a label (`joined` in `parse.ts`) is gone. | strings of the 2.1.316 binary (the reader of the answers) | `[observed]` in the binary, *inference* for the rule |
| C6 | Before the fix the mod ended a quoted piece at the first quote that a comma follows. The typed piece of C3 showed as two typed lines, `say "hi\` and `ok"`, in `/track qa`. | `track-qa-before-fix.txt` | `[observed]` *verified-live* |
| C7 | An away dialog (`CLAUDE_AFK_TIMEOUT_MS=8000`): `result` is `{ questions, answers: {}, annotations: {}, afkTimeoutMs: 8000 }`, the `text` says "No response after 8s …". The dialog counts down ("auto-continue in 5s · any key to stay"). The mod reads it as `partial` and `/track qa` says "The dialog answered itself after 8 s with nobody there." | `…toolu_afk_1.json` | `[observed]` *verified-live* |
| C8 | `Chat about this` in the terminal is an `isError` result, a string that starts `Error: The user doesn't want to proceed …` and then "The user wants to clarify these questions." with the questions listed. It has no `followUp` and no `response`. The mod reads it as `declined`. The two fields were not produced by any run: they stay *types-only* live. The terminal key never sets them. The 2.1.316 binary has a second path: the answer of a permission-prompt tool (`--permission-prompt-tool stdio`) may carry `response` (a string) and `followUp` (a boolean, only when every question has a string `kind`), and refuses only `afkTimeoutMs` (rule `host_field`) `[observed]` in the binary strings, not run. | `…toolu_chat_1.json` | `[observed]` *verified-live* for the terminal |
| C9 | A `$.ui.ask` of a second plugin reaches the hook of a third plugin. `e` holds `questions` (options with `description: ""`), `tool` and `tool_use_id` `toolu_plugin_<32 hex>`. No field names the plugin. The caller's own hook does not see the call (the types say so). The answer is `{ "Which colour?": "Blue" }`. `/track qa` says "asked by a plugin". | `…toolu_plugin_8576….json`, `asker.log` | `[observed]` *verified-live* |

Two things differ from what the tracker assumed. The quote reader was wrong (C3, C6, fixed with a test on the captured string). The text and number forms are a host option, not a model option, so the tracker reads them correctly but a stock terminal session never makes one (C1a). The live-checks that need a person or another app (the desktop app, a permission-prompt host that sets `followUp`) were not run; they are tracked in [#312](https://github.com/martin-macak/claude-code-mod-tracking/issues/312).

## Not tested

- An edit of a plan with `Ctrl+G` (or on the web), and a teammate plan that awaits its leader. The mod reads an approved plan from `result.plan` first and from the input second, so an edited plan shows when the result carries it `[inference]`. In every capture the two are equal. The live check of an edit is [issue #312](https://github.com/martin-macak/claude-code-mod-tracking/issues/312)
- The copy of a call to the clipboard: the mod calls `ui.copy` ([d.ts:2593](../sources/claude-code-2.1.302/types/claude-code.d.ts#L2593)). The kit checks the call and the text `verified-kit`. A live run (2.1.307) heard the event in a probe plugin that answered it without `next`, so the text of the key is proven and the clipboard stayed as it was `[observed]`. A second live run (2.1.316, 2026-11-01, no probe, clipboard guarded) saw the engine write the Markdown of the call to the tmux buffer and to the stdin of `pbcopy`, and the real clipboard did not change `[observed]` `verified-live` (open question 49). The scenario also compares the change counter of the macOS pasteboard before and after. In 2.1.316 the native addon never loads (its loader returns null), so macOS has no unguarded native route. Not run: a bare OSC 52 write, which cannot be told from `tmux load-buffer` in a tmux buffer.
- A run of `followUp` and `response` through a permission-prompt host (stdio), the sliders of a number question in a host that draws one ([#312](https://github.com/martin-macak/claude-code-mod-tracking/issues/312)), and any version but 2.1.302, 2.1.306 and 2.1.316.

## Keeping `/track qa` from the model

Issues [#196](https://github.com/martin-macak/claude-code-mod-tracking/issues/196) (the spike) and [#246](https://github.com/martin-macak/claude-code-mod-tracking/issues/246) (the build). The question: can a mod draw the Markdown of `/track qa` in the row, and keep it out of the next model request? The reply of a command is a transcript line, and the engine puts it in the next request as `<local-command-stdout>` ([turn-strip](turn-strip.md), S12). A `ui.render` hook on `CommandOutput` that rewrites `text` draws the rewrite and leaves the stored row alone. So the command answers a stub, and the hook draws the Markdown.

Verdict: **verified-live** on Claude Code 2.1.310 and again on 2.1.311, for the terminal (main screen and fullscreen), with a fake Messages API behind the engine (no model, no login). The real mod then ran the same way on **2.1.312** (the `e2e/features/questions.feature` scenarios "A question and my answer are listed by /track qa, word for word" and "/track qa --send gives the model the whole text"). **verified-kit** for `claude -p`. **types-only** for the desktop app, the mobile app and the VS Code host. The probes, the logs and the sources are in [spikes-2026-10-26](../sources/spikes-2026-10-26/README.md) (#196, 2.1.310) and [spikes-2026-10-27](../sources/spikes-2026-10-27/README.md) (#246, 2.1.311).

| Fact | Evidence | Tag |
| --- | --- | --- |
| The hook fires for a row of a plugin command. `requestId` is the uuid of the stored stdout row, `command` the registered name, `args` all that follows the name (`qa 3`), `text` is `<plugin>: <reply>`. | #196 S1 | `[observed]` 2.1.310 |
| A `text` rewrite draws in the row (main screen, fullscreen, the ctrl+o view) as Markdown. The stored rows hold the stub only. | #196 S2, #246 E6 | `[observed]` 2.1.310, 2.1.311 |
| The next request holds the stub and none of the rewrite. The fake API scanned every message of the request. A control command with no rewrite shows that the detector sees a command reply. | #196 S3, #246 E7, e2e step `no command reply to the fake model holds …` | `[observed]` 2.1.310, 2.1.311, 2.1.312 |
| The rewrite replaces the whole drawn text, the plugin prefix too (`<plugin>:`). A prop that the hook did not change must go on as received: `onScreen` exists in the fullscreen layout. | #196 S1, #246 E6 | `[observed]` |
| The reply is drawn as Markdown after the prefix on the same line. A title that starts the reply draws a literal `#` (`artifact-tracking: # Questions and answers`). One leading line break puts the prefix alone on its line, and the title is a heading. The same for `##`. | #246 S1, E2 to E5, and the e2e step `the screen does not show "# Questions and answers"` | `[observed]` 2.1.311, 2.1.312 |
| `claude -p` draws nothing: `$.session.surfaces()` is `[]`, `isInteractive` is `false`, and the reply is the only output (the stub, when the command answered one). The real mod under `claude -p --continue` prints the whole text of `/track qa`, `/track qa 1` and `/track qa --send`, with a call that the replay read back from the transcript. | #196 S5, #246 E1b, E8, E9, [headless-real-mod.log](../sources/spikes-2026-10-27/p246-probe/headless-real-mod.log) | `[observed]` *verified-kit* (2.1.310 to 2.1.312) |
| The row draws 100 000 characters at most, then `… N more characters, not drawn`, and the engine adds a notice row that no request holds. The mod keeps the newest whole calls under the limit and names the others. | #196 S7 | `[observed]` 2.1.310 |
| An empty reply (`text: ''`) keeps a row with the text `<plugin>:`. A reply of `{}` stores no row and raises no render. | #196 S8 | `[observed]` |
| A resumed session raises the hook for each restored row with the same `requestId`, `args` and stub, before the slot has loaded. A redraw (`$.ui.invalidate('ui.render')`) draws the row again. On the main screen with a transcript taller than the terminal, the scrollback keeps the stub of the first paint and a mixed copy. Fullscreen is clean. | #196 S6 | `[observed]` 2.1.310 |
| The guard `cc-plugin-sec-default` hooks neither `ui.render` nor `command.run`, so it does not stand in the way. Nothing tried to bypass it. | #196 S9, #246 E0 | `[observed]` on a machine with managed settings |
| The model already holds the Q&A of its own `AskUserQuestion` calls. The stub removes only the copy that `/track qa` adds. | #196 S10 | `[observed]` |
| In a kit test the hook's `$.session.surfaces()` rejects with `no implementation for session.surfaces` unless the test answers that event. The surface of `$.session.start` does not feed it. | #246 K0, K0b, K1 | `[observed]` *verified-kit* |
| A kit test sees what `next` received when it mounts a `CommandOutput` row with an `on('ui.render')` beneath the plugin. It cannot read a model request. | #246 K3 | `[observed]` *verified-kit* |
| The desktop and the mobile app raise `CommandOutput` and should draw the rewrite. The 2.1.302 types said the VS Code host attaches no surface, so `surfaces()` would be empty there and the mod would answer the whole text. The 2.1.310 and 2.1.312 types drop that wording, and public docs say the VS Code panel and Remote Control draw no mod output, so that host may show only the stub. Nothing was tried there. | [d.ts:10446-10455](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10446-L10455), [d.ts:10796-10798](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10796-L10798), [open-questions](../open-questions.md), 1 | `[primary source]` *types-only* |

```mermaid
sequenceDiagram
  actor P as Person
  participant E as Engine
  participant R as Commands router
  participant Q as Questions tracker
  participant H as CommandOutput hook
  participant M as Model (next request)
  P->>E: /track qa
  E->>R: command.run (args "qa")
  R->>E: $.session.surfaces()
  E-->>R: ["terminal"]
  R->>Q: screen.stub(ctx, "")
  Q-->>R: "Questions and answers Q1–Q7 (7 calls): drawn on the screen only. ..."
  R-->>E: { text: stub }
  E->>E: store the stdout row "artifact-tracking: stub"
  E->>H: ui.render CommandOutput (args "qa", text = prefix + stub)
  H->>Q: screen.draw(ctx, "", text)
  Q-->>H: Markdown of Q1 to Q7 (masked, cut to fit)
  H-->>E: next({ ...e, props: { ...props, text: Markdown } })
  E->>P: the row draws the Markdown
  P->>E: next prompt
  E->>M: the request holds the stub only
```

What the mod does (issue #246):

- `CommandSpec.screen` (`stub`, `draw`) on `qa`. It counts only with `text`. The router answers the stub where `$.session.surfaces()` is not empty (any surface name, not only `terminal`), or when the read fails, and the whole text where it is empty. `/track qa --send [n]` always answers the whole text (any case, before or after `n`). The usage line, `No questions asked in this session.` and `No call 9. Calls kept: …` stay plain.
- One hook on `{ component: 'CommandOutput', props: { command: 'track' } }` (`hooks/register.tsx`). It finds the stub at the start of `text`, after the plugin names that the engine puts in front, so a whole-text row that quotes the stub words stays with the engine, and draws exactly the calls the stub names, with the mask and the limits of the config as they are at draw time. A row with no stub, an error, a failed read and a slot that holds no call of the range go to the engine's own row.
- `SwitchRunner.loadSession` asks one redraw after the stored copy and the replay are in. The engine fires `session.end` only for an in-process `/resume`, and no hook sees the new id, so `SessionEnd` arms checks at 0.25 s, 1 s and 3 s after a `resume` end (`RESUME_CHECKS_MS`); the first that sees the id move carries the switch. The tick, every 30 s by default, is the other redraw. `/branch` renumbers from the main transcript only.
- The reply of `qaText` starts with a line break, for the whole list and for one call. `qaMarkdown` and `callMarkdown`, which the copy key `y` uses, do not.
- After `/track clear` the numbers start again from `Q1`. An old stub row then draws the stub (no call of its numbers is left), and later a call that has one of its numbers. The stub names numbers only (owner decision OQ4 of #196), so it cannot tell the two apart.

How the acceptance criteria of #196 are met: AC1 and AC2 by the rows above (the row draws the Markdown, and the stored row and the next request hold the stub), AC3 by this section, AC4 by the `claude -p` row, AC5 by the build of #246.

Not tested (see [open-questions](../open-questions.md), 50 to 54): the desktop and the mobile app, a machine without the guard, a real model, the VS Code host, and a resume of a real session with the real mod (the redraw after a resume was seen live with the probe mod on 2.1.310 only). The e2e harness has no headless step, so the `claude -p` run of the real mod was made once by hand (the log above) and the kit test with `surfaces: []` holds the rule.

## What the mod does with it

[`trackers/questions/`](../../../../plugins/artifact-tracking/trackers/questions/) reads `result.result` and never the text, except for the pieces of a multi-select answer. The words of a refusal, with the note of a rejected plan, are the string `result.result` (it keeps the engine's `Error:` mark). The text is the fallback for a transcript use that stored no `result`. See the README section [Questions and answers](../../../../plugins/artifact-tracking/README.md#questions-and-answers).
