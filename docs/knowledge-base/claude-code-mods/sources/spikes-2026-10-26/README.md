# Spikes, 2026-10-26

Source files and the evidence log of the probe behind the section [Keeping `/track qa` from the model](../../concepts/questions-and-plans.md#keeping-track-qa-from-the-model). It ran for [issue #196](https://github.com/martin-macak/claude-code-mod-tracking/issues/196) on Claude Code **2.1.310** (the types snapshot is 2.1.302), macOS, on 2026-10-26, against a fake Messages API (no model, no login). The study text is in the first comment of the issue, the evidence log in the second and these sources in the third; this folder is the third comment and the log, rebuilt as files.

This folder is evidence, not product. It is a snapshot: do not edit it. The folder `config-log-burst/` beside `p196-probe/` belongs to the study of [issue #219](https://github.com/martin-macak/claude-code-mod-tracking/issues/219) and has its own README. This file describes `p196-probe/` only.

## What is here

| Path | What it is |
| --- | --- |
| `p196-probe/probe/` | The probe mod `p196-probe`: eight commands, one `ui.render` hook on `CommandOutput`, and log hooks on `command.run`, `session.append`, `session.start` and `turn.complete`. |
| `p196-probe/fake/fake196.mjs` | A fake Messages API. For each request it logs which probe markers the body holds, anywhere in `messages`. `seq-qa.json` is the script of the baseline run B1 (a scripted `AskUserQuestion`). |
| `p196-probe/run.sh`, `run-mod.sh` | The launchers: a clean environment, a scratch config folder, the fake API, the probe mod (`run-mod.sh`: a copy of the real mod, B1). |
| `p196-probe/drive.sh` | A tiny tmux driver on the private socket `p196`. |
| `p196-probe/build-evidence.mjs` | Builds the numbered, scrubbed evidence log from the saved logs. |
| `p196-probe/evidence-log.txt` | The log itself: runs H1 to H7 (`claude -p`), T1 to T9 (tmux, main screen and fullscreen, fresh and `--continue`), B1 (the real mod today) and the types check. `L<n>` of the study and of issue #246 is line `n` of the sections of this file. |

Left out on purpose: `out/req-*.json` (the request bodies hold the system prompt), `cfg/` (session transcripts and debug logs) and `trackcfg/`. `<SCRATCH>` stands for the scratch folder that held all of these. Set it to a folder of your own before you run the probe.

## What it showed

| Question | Answer | Grade |
| --- | --- | --- |
| Does a `text` rewrite of a `CommandOutput` row draw while the stored row keeps the stub? | Yes: main screen, fullscreen and the ctrl+o view. | *verified-live* (2.1.310) |
| What does the next model request hold? | The stub. Never a marker that only the rewrite holds. A control reply shows that the detector sees a command reply. | *verified-live* |
| What does `claude -p` do? | No render. `surfaces()` is `[]`, `isInteractive` is `false`, and the reply is the whole output. | *verified-kit* |
| Does it draw again after `--continue`? | After an invalidate, yes. On the main screen with a transcript taller than the terminal, the scrollback keeps a stub line and a mixed copy. | *verified-live* |
| Is there a size limit? | The row draws the first 100 000 characters and a notice row follows. | *verified-live* |
| Does the guard `cc-plugin-sec-default` stand in the way? | No: it hooks neither `ui.render` nor `command.run`. Nothing tried to bypass it. | *verified-live*, on a machine with managed settings |

## How to run it again

1. Make the folders `probe/.claude-plugin`, `probe/hooks`, `fake`, `out`, `caps`, `cfg`, `trackcfg` and `work` (a throwaway git repo with one empty commit) in a scratch folder, and copy the files.
2. `cfg/.claude.json`: `{ "hasCompletedOnboarding": true, "theme": "dark", "bypassPermissionsModeAccepted": true, "projects": { "<SCRATCH>/work": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }`. Add the same entry for the `/tmp/...` form of the path (macOS links `/tmp` to `/private/tmp`).
3. `claude plugin validate <SCRATCH>/probe`.
4. Start the fake: `PORT=8796 OUT=<SCRATCH>/out node fake/fake196.mjs`. Give each run its own `OUT` folder: after a restart the fake numbers the bodies from 1 again.
5. Headless: `run.sh -p "/p196 qa" --output-format json`, then `run.sh -p --continue "next"`. Interactive: `tmux -L p196 -f /dev/null new-session -d -s tui -x 150 -y 60 "env ALARM=900 NOFLICKER=0 <SCRATCH>/run.sh"`, then `drive.sh type "/p196 qa"`, `drive.sh cap <file>`. `NOFLICKER=1` is fullscreen.
6. Clean up: `tmux -L p196 kill-server`, stop the fake, and check `ps`.

The commands of the probe:

| Command | Reply (`command.run`) | Render hook |
| --- | --- | --- |
| `/p196` | stub `STUB196T` | `text` rewrite to a 24-line Markdown (`QA196T`) |
| `/p196r` | stub `STUB196R` | its own tree (`QA196R`) |
| `/p196c` | `# CTRL196-MARKER …` | none (control) |
| `/p196e` | `''` | `text` rewrite (`QA196E`) |
| `/p196n` | `{}` (no text) | `text` rewrite (never raised) |
| `/p196s` | the whole Markdown when `$.session.surfaces()` is empty, else stub `STUB196S` | `text` rewrite unless the text is the whole Markdown |
| `/p196d` | stub `STUB196D` | draws the stub until a timer sets "loaded" and calls `$.ui.invalidate('ui.render')`, then the rewrite |
| `/p196l` | stub `STUB196L` | a 177 552-character rewrite |
