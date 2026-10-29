# e2e

Gherkin scenarios that drive a real `claude` in tmux. The same harness records the README demo GIF (`make demo`). The design is in [`docs/superpowers/specs/2026-10-11-demo-pipeline-design.md`](../docs/superpowers/specs/2026-10-11-demo-pipeline-design.md). The steps and the way to write a scenario are in the [`demo-scenario`](../.agents/skills/demo-scenario/SKILL.md) skill.

| Command | What it does |
| --- | --- |
| `make e2e-unit` | Unit tests of the harness. No `claude`. Runs in CI. |
| `make e2e-safe` | Every scenario against a real `claude`, except `@artifacts`. It runs the default profile. This is the default local run. Needs a Claude login and tmux. Local only. |
| `make e2e` | Every scenario against a real `claude`, the `@artifacts` scenario included (`-p all`). It publishes a private page to claude.ai with your login. Run it too after a change to the artifact tracker or to the `@artifacts` scenario: that scenario is the only live check of the tracker (`AGENTS.md`, "Lint and hooks"). Needs a Claude login and tmux. Local only. |
| `npx cucumber-js` (in `e2e/`) | The same selection as `make e2e-safe`: the default profile. Use it to add flags, such as `--tags`. |
| `make demo` | Records the `@demo` scenario and renders `docs/assets/demo.gif`. |

## The terminal size

A scenario runs at `DEMO_COLS` by `DEMO_ROWS`, 120 by 36 by default. At 120 columns the `/track` pane is docked beside the transcript. At 100 columns it is inline: a box under the transcript.

A scenario can set its own size with a `Given` step. Put it before the step that starts the session:

```gherkin
Given a terminal of 100 columns by 40 rows
And a Claude Code session with the artifact-tracking mod
```

The step fails when the session has started already, and in a recorded scenario (`DEMO_RECORD=1`). `DEMO_COLS` and `DEMO_ROWS` stay the default for every scenario that has no such step.

The pane marks its selected row with a gutter `>`. A docked pane draws `│>`, an inline pane draws `│ >`. The step `the selected row shows "…"` reads both. The size alone does not say where Claude Code seats the pane, so a scenario that runs at two sizes says which placement each one expects: `Then the pane is docked` or `Then the pane is inline`. The step reads the close mark `✕` of the pane: on a top border (`╭──✕─╮`) the pane is inline, on a row of its own beside the transcript it is docked.

The help view prints the path of the config file, and a long path wraps onto a row of its own. The width of the temporary folder differs by system (`/var/folders/...` of a Mac is 85 cells, `/tmp` is 40), so a scenario that counts the rows of the help view sets the width: `Given the tracker config file path is 90 cells wide`. Put it before the step that writes the config file. It fails when the temporary folder is wider than that already: set `TMPDIR` to a shorter folder.

## The tools of the session

A session that starts with `a Claude Code session with the artifact-tracking mod` (with or without a prompt) has no tool at all: the harness starts `claude` with `--tools ''` (no built-in tool) and `--strict-mcp-config` (no MCP server of your own account; the repo declares none, and the mod needs none). The model cannot run a command (`Bash`), read or write a file, search or call a connector, whatever a prompt asks. `node bin/drive.ts start` starts a session of this kind too, so it has no tool either: use it to look at the screen of a scenario without tools. The demo system prompt also says "Do not use any tools", but a sentence does not hold: the resolve key sends a prompt that asks for git and gh work, and a model that followed it ran `gh pr view` ([#215](https://github.com/martin-macak/claude-code-mod-tracking/issues/215)). The permission mode does not help either. A session can start in auto mode although `--setting-sources project` is set (seen on Claude Code 2.1.308 with `permissions.defaultMode: auto` in the user settings), and then it runs commands with no dialog. The mod itself needs no tool: `/track` and the pane are not tools.

The diff mode of the file preview (issue [#254](https://github.com/martin-macak/claude-code-mod-tracking/issues/254)) needs a base to diff against. The clone of a scenario has an `origin/HEAD` only when the checkout that made it was on a branch: from a checkout that is detached (a rebase in progress, a bisect, the merge ref of a CI run) it has none, and the diff says that it has no base. `And the clone has origin/HEAD at its HEAD` pins it (`pinOriginHead` in `support/session.ts`). Put it after the step that starts the session: the mod asks git when the view of a file opens, and when the diff is shown.

A scenario that needs tools says so in its session step: `a Claude Code session with the artifact-tracking mod and the tools "Read Write Edit"`. That session has the default tool set, and the listed tools run without a permission dialog. Any other tool, `Bash` included, can still open a dialog or, under an auto permission mode, run at once, and a scenario that gives tools must plan for it.

## The lock

One run at a time can use the machine: the tmux socket `cc-demo`, the folder `$DEMO_DIR` and the Claude session are shared. Each scenario takes the lock `$TMPDIR/cc-demo-lock/.lock` in its `Before` hook and lets it go in its `After` hook. The file holds the pid of the run. A run with a socket and a folder of its own does not take this lock: see [A private socket](#a-private-socket).

A scenario that finds a live run on the lock waits for it:

- It tries again every 5 s. It stops after 30 minutes. `DEMO_LOCK_WAIT_S` sets the bound in seconds. `0` means do not wait: the scenario fails at once. The bound covers the whole wait for the run that holds the lock, so several queued runs of 7 minutes each can use it up: raise it for a long queue.
- It prints on stderr who holds the lock or is ahead in the queue: the pid, how long it runs and its command line. The command line shows the worktree of that run. It prints again when that run changes, and once a minute while it waits.
- After the bound it fails with `lock: another demo run (pid N) holds …. Waited 30 min for it and gave up.` For a run ahead in the queue the text is `… (pid N) is ahead of this run in the queue for …. Waited 30 min for its turn and gave up.` Later scenarios of the same run do not wait again: each tries once and fails at once.
- It never removes the lock of a live run. A lock of a dead process is taken over. A lock that your own run holds and did not release fails at once, because waiting could not end.

Runs get the lock in the order they came. Each run takes one ticket at its first claim: an empty file `<number>-<pid>` in `$TMPDIR/cc-demo-lock/.lock.queue/`. The oldest live ticket is the first run. A run that is not first does not try the lock. So a run that starts in the moment between two scenarios of the first run cannot take that moment: it waits behind the runs that came before it. The first run takes the lock again for its next scenario. A run leaves the queue when its last scenario is done (the `AfterAll` hook) and when its process exits. Runs that start in the same instant share a number, and the lower pid goes first. If the run with the higher pid took the lock first, the first run takes the lock the moment it is free, and the other run waits behind the first run for its next scenarios: the queue orders the runs, not the order of the first try. Each scenario still sets up and cleans up in full while it holds the lock.

A scenario that fails, by the bound or because it does not wait, gives its ticket back, so it holds no other run back. The next scenario of that run joins the queue again at the back. With `DEMO_LOCK_WAIT_S=0` a scenario fails at once while a live run is ahead in the queue, and takes a free lock when no run is ahead. A no-wait run that came first keeps its place for its next scenarios.

A run that ends by Ctrl+C, `SIGTERM` or `SIGKILL` runs no exit hook. Its ticket and its lock stay with a dead pid. The next run removes the ticket of a dead process by its name and takes over the lock of a dead process. A pid that the system gave to another process keeps the dead ticket alive until that process ends: the notes show the command line of the run ahead, so you can tell.

A checkout from before the queue has no ticket. It can still take the lock in the moment between two scenarios of a run, and a run that waits for it waits for its process, as it did before the queue. A run with a ticket is not waited for by its process, also when it leaves the queue and its process lives on: the queue orders it. A checkout from before the wait fails at once while another run holds the lock, also in that moment. Rebase it onto `main` to get the queue and the wait. The lock file format did not change, so old and new runs see each other.

Do not remove the lock by hand and do not kill a process you did not start. To see who holds it: `ps -p "$(cat "$TMPDIR/cc-demo-lock/.lock")" -o pid,etime,command`. The queue is the file names in `$TMPDIR/cc-demo-lock/.lock.queue/`: the number first, then the pid.

## A private socket

A run that has its own tmux socket and its own folder does not wait for the shared lock (issue [#185](https://github.com/martin-macak/claude-code-mod-tracking/issues/185)). It runs while other runs hold the lock, and two such runs go at the same time. Use it for a live check of one scenario when other lanes keep the lock, and for sweeps of many short runs.

```sh
cd e2e
DEMO_SOCKET=lane-a DEMO_DIR=/tmp/cc-demo-lane-a npx cucumber-js -p one features/config.feature:4
```

- `DEMO_SOCKET` is the name of the tmux socket (`tmux -L`). It is one plain name: letters, digits, `.`, `_` and `-`, and it starts with a letter or a digit. The default is `cc-demo`.
- `DEMO_DIR` is the folder of the clone. The default is `/tmp/cc-demo`. The harness resolves the path first, so `/tmp/cc-demo/` is the default too. A symlink to the default folder (`/private/tmp/cc-demo` on a Mac) is not seen: do not use one.
- A run is private only when both differ from their defaults. With one of them alone the run takes the shared lock as before, because the other one is still shared with every run that has the default.
- A private run takes a lock of its own socket, `$TMPDIR/cc-demo-lock-<socket>/`, with the same wait and queue as the shared lock. Two runs on the same private socket wait for each other. Runs on other sockets do not, and neither does a run of the shared lock: it never sees the lock of a private run.
- The output of a private run goes to `e2e/out/<socket>/<scenario>/`, so the same scenario on two sockets does not wipe the folder of the other.
- A recording (`DEMO_RECORD=1`, `make demo`) is never private. It takes the shared lock and writes `e2e/out/demo/`.

Limits:

- Give each run its own socket and its own `DEMO_DIR`. The lock keys on the socket alone. Two runs with different sockets and the same `DEMO_DIR` wipe the clone of each other, and nothing stops them.
- The Claude login and `~/.claude`, the model and the CPU of the machine stay shared. The lock no longer keeps the runs apart, so they add load to each other and to every other job on the machine, and a tight wait can fail. On 2026-10-29, on a Mac with other lanes at work (load average 12, 16 and 27 over 1, 5 and 15 minutes at one reading; Claude Code 2.1.312), 10 of 28 sessions of two concurrent runs of one model-turn scenario failed: the prompt stayed unsent in the box (a key press did not send it either) until the turn timeout, and both runs of a pair failed together in 4 of 14 pairs. One run at a time failed 1 of 8 times on a private socket and 0 of 6 times on the default one. This is the signature of [#269](https://github.com/martin-macak/claude-code-mod-tracking/issues/269). The cause is not known. Raise `DEMO_SCREEN_TIMEOUT_S` and `DEMO_TURN_TIMEOUT_S` for a large sweep, run one scenario in each process (`-p one` with one position), and expect to rerun a turn that stalled.
- Watch a run with files and `ps`. `pgrep -f 'e2e/out/<socket>/'` finds the `claude` process of a run: its command line holds the signal file. The lock files show who holds each lock.
- `@artifacts` still publishes a private page to claude.ai with your login and deletes it, on a private socket as on the default one. Two such runs publish two pages. The default profile and the profiles `one` and `demo` skip it: do not pick `-p artifacts` or `-p all` for a private run unless you mean it.
- A private run removes its clone at the end. The folder `$DEMO_DIR`, `e2e/out/<socket>/` and `$TMPDIR/cc-demo-lock-<socket>/` stay. They are small. Remove them when you no longer use the socket name.
- A run that crashed leaves its tmux server on its socket. The next run on that socket kills it, as on the default socket.

## A fake model

A turn that the real model would not give twice, such as a question with the `AskUserQuestion` tool, needs a model that is a script. `support/fake-api.ts` is a fake Messages API on `127.0.0.1`. It plays the turns of a list, one for each request that carries tools, and streams each as the real API does. A request with no tools (the engine names the session with one) gets a fixed answer and takes no turn. The script must end in a turn of text.

A scenario starts it with a `Given` step, before the step that starts the session (`features/questions.feature`). The session then runs against the fake:

- `ANTHROPIC_BASE_URL` is the fake and `ANTHROPIC_AUTH_TOKEN` is `fake`. No account and no network are used.
- `CLAUDE_CONFIG_DIR` is an empty folder of the scenario, so no login or setting of the person reaches the run. The harness removes the folder at the end.
- The variables of a Claude Code session that runs the harness (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, the messaging socket and the bridge) are removed for claude only, so claude does not join its parent. `support/fake-api-env.ts` lists them.

The dialog, the key, the hook and the mod are real: only the model is a script. `Then the fake model was told "…"` reads what the engine told the model about its tools. An Esc aborts the turn and the Stop hook does not run for it, so a scenario that presses Esc waits for the screen and not for `Claude finishes`.

## A probe for the copy key

The copy key of the questions tracker hands its text to the engine (`$.ui.copy`), and the engine then writes the clipboard of the machine. `Given a plugin that answers ui.copy and logs the text` adds a second plugin to the session (`support/copy-probe.ts`, an extra `--plugin-dir`). It hears the `ui.copy` event, writes the text to a log beside its folder and answers `{ isCopied: true }` without `next`, so the engine writes nothing. `Then the copy log holds "…"` reads the log. Put the step before the step that starts the session. The folder of a plugin is watched, so the log never lies inside it.

## A probe that refuses a timer

A hook of one plugin can deny the `$.clock.after` call of another. The timer never fires and the caller hears nothing: a `Timer` has `cancel` and no more. The key press of the `/track` pane waits for such a timer before it asks for the ring (issue [#193](https://github.com/martin-macak/claude-code-mod-tracking/issues/193)). `Given a plugin that refuses clock.after of N ms` adds a second plugin to the session (`support/timer-refuser.ts`, an extra `--plugin-dir`). It denies the `clock.after` of exactly `N` ms and passes every other delay with `next`, so no other timer of the mod is dropped. Deny a delay that no other timer of the mod shares: the pause of the ring is 10 ms, and 1000 ms is also the default of `refresh.captureDebounceMs`. The probe counts its refusals in a log beside its folder. `Then the timer refuser has refused a timer` waits for the first one, so a check of the ring cannot pass in a run where nothing was refused. Put the first step before the step that starts the session. The folder of a plugin is watched, so the log never lies inside it.

A check of the ring alone cannot tell the wake from a stray drawing: any drawing 10 ms or more after the frame ends the wait as well, and the ring is then right with no wake. The mod writes one line to its debug log when the wake ends a wait (`$.ui.log(…, { to: 'debug' })`), and no drawing writes it. `Given the session writes a debug log` makes the launch pass `--debug-file` with a file in the folder of the scenario (`out/<scenario>/debug.log`, empty at the start). `Then the debug log shows "text"` waits for a line that holds the text, as it is and not as a pattern. Put the first step before the step that starts the session. A step of another scenario can use the pair for any line that the mod writes to its debug log and the screen does not show.

The keys that wait in the chain behind a press with a refused timer are a kit test (`pane-session.test.ts`): a key typed through tmux comes after the wake of the mod, so a scenario could not tell the wait from the delay of the typing.

## A second repo

The PR lane also polls a branch that the session proved in another repo (issue [#195](https://github.com/martin-macak/claude-code-mod-tracking/issues/195)). `features/foreign-repos.feature` shows it with a fake model and the fake `gh`, so it needs no login. Put the steps after `a fake GitHub repo ...` and before the step that starts the session:

- `a second fake GitHub repo "owner/repo" on the branch "…"` makes the repo with `fakeForeignRepo` (`support/session.ts`): one commit and a README, on that branch, from nothing. Its `origin` is the GitHub URL, and `url.<copy>.pushInsteadOf` sends a push to a bare copy, so a push cannot reach GitHub. The mod reads the repo from `git remote get-url origin`, so `insteadOf` would give a local path and no GitHub repo. The mod never fetches it.
- `the fake gh reports PR #N "title" in "owner/repo" from "head" into "base" as MERGEABLE` adds a PR to that repo. The spec of the fake has `others`: the discovery and the refresh answer for each repo of it, and `repo view` names the first.
- `a fake model that reads the README of the second repo` plays a turn that calls `Read` on the README, then says `Read.`. The scenario names the tool in its session step: `and the tools "Read"`.
- `Then the fake gh answered a discovery of "owner/repo"` polls the log for the discovery query of that repo.

The repo lives in `$HOME/.cache/cc-demo/run-…` and the scenario removes it at the end (`DEMO_KEEP=1` keeps it). It must not be in a temporary folder or in one of Claude's own: the repos tracker treats those as noise and makes no row of a repo there.

## Run one scenario

`make e2e-safe` and `npx cucumber-js` run every scenario except `@artifacts`. `make e2e` runs every scenario. Pick fewer with a tag, a name or a file position:

| Goal | Command (from `e2e/`) |
| --- | --- |
| Scenarios with a tag | `npx cucumber-js --tags @inline-help` |
| A scenario by name | `npx cucumber-js --name 'Tab moves the selection'` |
| One scenario by its line | `npx cucumber-js -p one features/pane.feature:42` |
| The `@artifacts` scenario alone | `npx cucumber-js -p artifacts` |
| Check what runs, with no run | add `--dry-run` to any of them |

A positional argument such as `features/pane.feature:42` does not replace the paths of the default profile. It merges with them. So `npx cucumber-js features/pane.feature:42` runs that scenario and also every scenario of the other feature files. The profile `one` has no `paths`: with `-p one` only the position that you name runs. (With no position at all, cucumber runs every feature file.)

A line number that points at a `Scenario Outline` or at one row of its `Examples` table picks all examples or that one example.

Tags in use: `@demo` marks the scenario that `make demo` records. `@artifacts` publishes a private page to claude.ai with your login and deletes it. The default profile and the profiles `one` and `demo` skip it, so a bare `npx cucumber-js features/pane.feature` is safe. `--tags 'not @artifacts'` still works and means the same. Opt in with `-p artifacts` (that scenario alone) or `-p all` (every scenario, as `make e2e` does). `make e2e-safe` names no profile, so it takes the default one and never opts in. `--tags @artifacts` on the default profile selects nothing: cucumber joins the tag expression of the profile and the one of the command line with `and`, so `(not @artifacts) and @artifacts` is empty. A guard test in `tests/cucumber.test.ts` fails when any other profile can select the `@artifacts` scenario. Another test there runs `--dry-run` with the recipe of each target and pins the scope: `make e2e-safe` selects every scenario but `@artifacts`, and `make e2e` selects those plus `@artifacts`. `@inline-help` is the help view of the inline pane at 100 by 40, with a config file path of 90 cells. `@help-view-keys` is the help view keys scenario of issue #200: `g`, `a`, `t`, `p` and `m` keep the keyboard in the pane, and the ring stays on its Button, docked at 120x36 and inline at 100x40. `@plan-view` is the plan view scenario of issue #199: `p` shows the clean plan, the ring is on `p: back`, `g` does nothing there and `p` again returns to the row, inline at 100x40.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_COLS`, `DEMO_ROWS` | `120`, `36` | The terminal size of a scenario with no size step. |
| `DEMO_LOCK_WAIT_S` | `1800` | How long a scenario waits for the lock. `0`: do not wait. |
| `DEMO_SCREEN_TIMEOUT_S` | `20` | The bound of each wait for the screen. |
| `DEMO_TURN_TIMEOUT_S` | `120` | The bound of one model turn. |
| `DEMO_TYPE_DELAY_MS` | `35` | The pause between two typed characters. |
| `DEMO_MODEL` | `haiku` | The model of the session. |
| `DEMO_DIR` | `/tmp/cc-demo` | The folder of the clone of the repo. A private run needs one of its own. |
| `DEMO_SOCKET` | `cc-demo` | The tmux socket of the run. With a folder of its own too, the run skips the shared lock: [A private socket](#a-private-socket). |
| `DEMO_KEEP` | unset | `1` keeps the tmux session and the clone after the scenario. |
| `DEMO_RECORD` | unset | `1` records the `@demo` scenario. `make demo` sets it. |
