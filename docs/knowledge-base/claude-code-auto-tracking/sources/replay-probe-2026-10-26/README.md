# Replay probe, 2026-10-26 (issue 202)

Probe of the replayed Bash result after a cold `--resume`, with a fake Messages API. Claude Code 2.1.310. No model, no login, no real PR. Observed on a managed machine (`cc-plugin-sec-default`).

| Path | What |
| --- | --- |
| `probe/` | Probe mod. Logs `session.start`, `turn.start`, `tool.call` (Bash) and `$.session.messages()` (also `{ agentId }` for each Agent tool use). `DIR` in `hooks/register.ts` is the output folder. |
| `fake-api.mjs` | Fake Messages API. Env: `PORT`, `SEQ` (turn script), `MARKER` and `MAINONLY=1` (advance the script only for main-loop requests that carry the marker and have tools). Its turn counter lives as long as the process: start a new one for each first process. |
| `bin/gh` | Fake `gh`: `pr create` prints a canned URL, no network. The e2e fake gh has no `pr create` answer. |
| `seq1.json` | Seven Bash calls: create, view, list, failed create, merge, chained create, comment. |
| `seq2.json` | Text only, for the resumed process. |
| `seq3.json` | A subagent that runs `gh pr create`. |
| `seq5.json` | The summary that answers `/compact`. |
| `run.sh` | Launcher with a clean environment (P1 to P4). |
| `map-check.ts` | Feeds a logged transcript through the repo's `transcriptItems`, `fromBash` and `recordPr`. |
| `logs/` | Probe logs, scrubbed. `ev-51436bb9` headless run and cold resume (not saved: equal to the TUI log but for ids and times). `ev-6a3ea756` TUI run and cold resume. `ev-66ef6d5e` subagent. `ev-4e872152` compaction. A resume keeps the session id, so a log holds one run after the other: count the `session.start` rows. |
| `p5/` | The TUI runs of P5 (real mod, e2e fake `gh`): `seq4.json` (one `gh pr create`), `fake-gh-spec.json` (PR 7 of `octo/demo`), `bin/gh` (the canned `pr create`, every other call to the e2e fake gh), `run.sh` (launcher), `screens/` (the pane rows of control and treatment). |
| `prototype/prototype.patch` | The handler and six tests, as a diff against `main` at 8c77e102, formatted by Biome 2.5.15. Not a commit. Case 6 holds the read of the transcript and waits with `until`: it has no fixed sleep. |

`<scratch>`, `<repo>` and `<study>` replace machine paths in the logs and in the scripts (`run.sh`, `p5/run.sh`, `p5/bin/gh`, `map-check.ts`, `probe/hooks/register.ts`). Set them before you run a script.

## P5 steps

1. Config dir: `.claude.json` with `hasCompletedOnboarding`, `theme`, `bypassPermissionsModeAccepted` and `hasTrustDialogAccepted` for the repo path. Mod config dir: an empty folder (`CLAUDE_TRACKER_CONFIG_DIR`).
2. Repo: `git init -b main`, one commit, `origin` = `https://github.com/octo/demo.git`. It stays on `main`: the fake PR has the head `feat/x`, and a checked-out `feat/x` would find the PR by the branch route.
3. Start the fake API: `PORT=8831 SEQ=p5/seq4.json MARKER="e2e probe" MAINONLY=1 node fake-api.mjs`.
4. First process: `tmux -L <name> new-session -d -s tui -x 160 -y 45 "p5/run.sh 8831 --plugin-dir <copy> --permission-mode bypassPermissions --session-id <uuid>"`. After 8 s send `run the e2e probe` and Enter. After 12 s send `/track` and Enter: the pane shows `Pull requests 1`. Send Escape, then `/exit` and Enter.
5. Cold resume: the same command with `--resume <uuid>` in place of `--session-id`. After 9 s send `/track` and Enter, then `capture-pane -p`. The copy is the unmodified plugin (control) or the plugin with the patch (treatment).
6. Stop the fake API and the tmux server. Start a new fake API before the next first process.
