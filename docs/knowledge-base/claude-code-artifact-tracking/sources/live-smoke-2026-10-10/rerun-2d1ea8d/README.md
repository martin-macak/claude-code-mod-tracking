# Live smoke rerun at 2d1ea8d, 2026-10-10

The first smoke run ([`../README.md`](../README.md)) tested `d8d410a`. Commit `2d1ea8d` ("Fix review findings") then changed `plugins/artifact-tracking/hooks/register.tsx`. The kit tests cannot model four of those changes. This run tests them in a real Claude Code 2.1.296 (`claude` on PATH). The work tree was clean at `2d1ea8d`.

## Safety

- No real model account. The model is the KB fake API ([`fake-api.mjs`](../../../claude-code-link-capture/sources/live-observations-2026-10-10/fake-api.mjs)) on `127.0.0.1:8812`. Port 8811 was already in use by another process, so this run used 8812.
- `ANTHROPIC_BASE_URL=http://127.0.0.1:8812`, `ANTHROPIC_AUTH_TOKEN=fake`, one fresh empty `CLAUDE_CONFIG_DIR` for each scenario. Every `CLAUDE_CODE_*` variable is removed from the child environment ([`outputs/00-env.txt`](outputs/00-env.txt) counts 0). The pty script asserts it.
- Real `gh` and `acli` calls, read-only: `--version`, one GraphQL read on `cli/cli#14622` and `cli/cli#14640`, `acli jira auth status`. No `acli auth` switch, login or logout. The Jira key `DEMO-1` is not on the active site, so no Jira read was made.
- Redaction: `<scratch>`, `<repo>`, `~`, `<user>`, `<site>.atlassian.net`. The scratch folders were in the system scratchpad, not in the repo.
- Same project setup as the first run: a fresh `git init`, `origin` = `git@github.com:cli/cli.git`, same fixed reply and prompt (`Please check #14622 and tell me where the fix is.`).

## Method

The first run used a fixed-timeline pty script and saved stripped text. This run needs waits of 35 s, a `/clear` sent 0.2 s after a prompt, and the exact screen at each moment. So [`scripts/pty-steps.py`](scripts/pty-steps.py) is new. It reads a list of steps (`wait`, `type`, `enter`, `esc`, `waitfor`, `snap`), feeds all pty bytes to a `pyte` terminal emulator (50 x 140), and writes the real screen at each `snap`. Every step has a UTC time in ms. Compare it with the `--debug-file` lines. `pyte` was installed in a venv in the scratchpad. [`scripts/stepsA.json`](scripts/stepsA.json) and [`scripts/stepsB.json`](scripts/stepsB.json) are the two scenarios. [`scripts/run-p.sh`](scripts/run-p.sh) (headless) and [`scripts/setup.sh`](scripts/setup.sh) are the first run's scripts with the port as an argument.

## Checks

| # | Check | Command | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Capture run, then `--continue "/track refresh"`. The gh status fills | `scripts/run-p.sh` (3 `claude -p --plugin-dir …` runs) | PASS | [`10-run1-prompt.txt`](outputs/10-run1-prompt.txt), [`20-run2-track.txt`](outputs/20-run2-track.txt), [`30-run3-track-refresh.txt`](outputs/30-run3-track-refresh.txt) |
| 2 | REPL: reply with items, then `/track`. Pane draws, band shows the counts | `pty-steps.py … stepsA.json` | PASS | [`40-repl-A-snaps.txt`](outputs/40-repl-A-snaps.txt), snaps `A1` and `A2` |
| 3 | Pane OPEN, `/clear`, wait one 30 s tick. The pane gets the items back with no new prompt | same run | PASS | `A3`, `A4` in [`40-repl-A-snaps.txt`](outputs/40-repl-A-snaps.txt), [`41-repl-A-steps.log`](outputs/41-repl-A-steps.log), [`61-debug-repl-A.txt`](outputs/61-debug-repl-A.txt) |
| 4 | `/clear` right after a capture (inside 1.5 s). The items survive | `pty-steps.py … stepsB.json` | PASS | [`42-repl-B-snaps.txt`](outputs/42-repl-B-snaps.txt), [`43-repl-B-steps.log`](outputs/43-repl-B-steps.log), [`62-debug-repl-B.txt`](outputs/62-debug-repl-B.txt) |
| 5 | Esc closes the pane. The log shows `ui.close` settled | both REPL runs | PASS | snap `A5`, `B3`. `ui.close settled` in `61-` and `62-` |
| 6 | Grep the debug logs for errors or refused trees from artifact-tracking | `grep` over all five logs | PASS | [`70-grep-errors.txt`](outputs/70-grep-errors.txt) |

## What each check showed

1. Run 1 got the fake reply. Run 2 listed the four items from the transcript (statuses still empty, as in the first run: `-p` ends before the background refresh). Run 3 (`/track refresh`) filled the real statuses: `cli/cli#14622` closed, `cli/cli#14640` open with failing checks, `DEMO-1` `track-only`. The header now says `refreshed just now` (review fix correctness-12). The first run printed `refreshed now ago`.
2. After the reply the band showed `tracking Jira 1 · GitHub 2 (1 ✗) · Links 1 /track`. `/track` drew the pane with the three sections and the real titles.
3. Timeline of run A (UTC, 2026-10-10):
   - `15:07:34.75` `/track` opened the pane. `startTick` started the 30 s timer.
   - `15:07:41.26` `/clear` sent with the pane open. The pane stayed open and showed `No tracked items yet.` (snap `A3`, 2 s later). Nothing more was typed.
   - `15:08:04.764` the tick fired (30.0 s after the open). The debug log shows `$.store.set s:f65511cc…` (the OLD id, saved by `ensureSession`) and then `s:8349d618…` (the NEW id) at `15:08:06.283`.
   - `15:08:17.7` snap `A4`: the pane shows all four items again, `gh · refreshed 30s ago`, with the statuses. No prompt, no `/track` since the `/clear`.
   - So the new tick path works with a real `/clear`. The 35 s wait was not awkward: the script just waits.
   - Small cosmetic point: in `A4` the keys read `cli/cli#14622`, not `#14622`. The tick path calls `ensureSession` (which resets `sessionRepo`) but not `ensureRepo`. The short key returns after the next hook or `/track` (see `B2`). It is not an error.
4. Run B sent `/clear` at `15:08:50.627`, 0.21 s after the prompt's Enter (`15:08:50.414`), with the reply already on screen. The capture had armed the 1.5 s flush timer. The timer fired AFTER the `/clear`, at `15:08:51.950`: `store.set s:388da78c…` (OLD id) and `15:08:51.965` `s:f2ae1504…` (NEW id), so the flush found the id change, saved the old session and carried the items over. Snap `B1` (3 s later) shows the band `Jira 1 · GitHub 2 · Links 1`. Snap `B2` (`/track`) lists all items and the pane has them with the real statuses after the refresh. The items survived. This run did not repeat the test at `d8d410a`, so it does not prove the old code lost them.
5. Esc closed the pane in both runs (`A5`, `B3`). `ui.close settled in 13.1ms` (run A, `15:08:18.108`) and `13.5ms` (run B, `15:09:00.604`).
6. No line with `artifact-tracking` has an error, warning, refusal, rejection or exception. The only `[ERROR]` lines are the Claude Code lock notice (`Lock acquisition failed … expected in multi-process scenarios`) and the telemetry opt-out check, in every log. Both are not from the mod. `plugin.register … admitted` appears in each log.

## Other observations

- `session.start` of the mod settled in 12 to 31 ms in every log (for example `session.start settled in 12.4ms` in `61-debug-repl-A.txt`). It no longer waits for the repo (correctness-8).
- Headless run 3 shows 0 `$.store.set` lines. The first run showed 2, by a narrow margin: the 1.5 s flush timer is armed late in a `-p` run, and the process can end first. The next run rebuilds the list from the transcript, so no data is lost. This is a timing effect, not a new defect. So no `50-store-after-headless-runs.json` was made this time.
- Bare `/track` in `-p` (run 2) shows no statuses, as in the first run.

## Not covered

- Old-code comparison for check 4, Jira refresh on the active site, GitHub Enterprise, resize and the desktop surface (same limits as the first run).
