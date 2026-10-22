# e2e

Gherkin scenarios that drive a real `claude` in tmux. The same harness records the README demo GIF (`make demo`). The design is in [`docs/superpowers/specs/2026-10-11-demo-pipeline-design.md`](../docs/superpowers/specs/2026-10-11-demo-pipeline-design.md). The steps and the way to write a scenario are in the [`demo-scenario`](../.agents/skills/demo-scenario/SKILL.md) skill.

| Command | What it does |
| --- | --- |
| `make e2e-unit` | Unit tests of the harness. No `claude`. Runs in CI. |
| `make e2e` | All scenarios against a real `claude`. Needs a Claude login and tmux. Local only. |
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

A scenario that needs tools says so in its session step: `a Claude Code session with the artifact-tracking mod and the tools "Read Write Edit"`. That session has the default tool set, and the listed tools run without a permission dialog. Any other tool, `Bash` included, can still open a dialog or, under an auto permission mode, run at once, and a scenario that gives tools must plan for it.

## The lock

One run at a time can use the machine: the tmux socket `cc-demo`, the folder `$DEMO_DIR` and the Claude session are shared. Each scenario takes the lock `$TMPDIR/cc-demo-lock/.lock` in its `Before` hook and lets it go in its `After` hook. The file holds the pid of the run.

A scenario that finds a live run on the lock waits for it:

- It tries again every 5 s. It stops after 30 minutes. `DEMO_LOCK_WAIT_S` sets the bound in seconds. `0` means do not wait: the scenario fails at once. The bound covers the whole wait for the run that holds the lock, so several queued runs of 7 minutes each can use it up: raise it for a long queue.
- It prints on stderr who holds the lock: the pid, how long it runs and its command line. The command line shows the worktree of that run. It prints again when the holder changes, and once a minute while it waits.
- After the bound it fails with `lock: another demo run (pid N) holds …. Waited 30 min for it and gave up.` Later scenarios of the same run do not wait again: each tries once and fails at once.
- It never removes the lock of a live run. A lock of a dead process is taken over. A lock that your own run holds and did not release fails at once, because waiting could not end.

Two runs that start together both pass, one after the other. A run lets go of the lock after each scenario and takes it again a moment later. A scenario that waits does not take the lock in that moment: once it has seen a run hold the lock, it waits for the process of that run, and tries again when the process has ended or when the lock is there again. So a waiting run gets its turn when the run it waits for ends, not between its scenarios. Each scenario still sets up and cleans up in full while it holds the lock.

A checkout from before the wait fails at once while another run holds the lock, also in that moment between two scenarios of a run. Rebase it onto `main` to get the wait. The lock file format did not change, so old and new runs see each other.

Do not remove the lock by hand and do not kill a process you did not start. To see who holds it: `ps -p "$(cat "$TMPDIR/cc-demo-lock/.lock")" -o pid,etime,command`.

## Run one scenario

`make e2e` runs every scenario. Pick fewer with a tag, a name or a file position:

| Goal | Command (from `e2e/`) |
| --- | --- |
| Scenarios with a tag | `npx cucumber-js --tags @inline-help` |
| A scenario by name | `npx cucumber-js --name 'Tab moves the selection'` |
| One scenario by its line | `npx cucumber-js -p one features/pane.feature:42` |
| Check what runs, with no run | add `--dry-run` to any of them |

A positional argument such as `features/pane.feature:42` does not replace the paths of the default profile. It merges with them. So `npx cucumber-js features/pane.feature:42` runs that scenario and also every scenario of the other feature files. The profile `one` has no `paths`: with `-p one` only the position that you name runs.

A line number that points at a `Scenario Outline` or at one row of its `Examples` table picks all examples or that one example.

Tags in use: `@demo` marks the scenario that `make demo` records. `@artifacts` publishes a private page to claude.ai and deletes it: skip it with `--tags 'not @artifacts'`. `@inline-help` is the help view of the inline pane at 100 by 40, with a config file path of 90 cells.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_COLS`, `DEMO_ROWS` | `120`, `36` | The terminal size of a scenario with no size step. |
| `DEMO_LOCK_WAIT_S` | `1800` | How long a scenario waits for the lock. `0`: do not wait. |
| `DEMO_SCREEN_TIMEOUT_S` | `20` | The bound of each wait for the screen. |
| `DEMO_TURN_TIMEOUT_S` | `120` | The bound of one model turn. |
| `DEMO_TYPE_DELAY_MS` | `35` | The pause between two typed characters. |
| `DEMO_MODEL` | `haiku` | The model of the session. |
| `DEMO_DIR` | `/tmp/cc-demo` | The folder of the clone of the repo. |
| `DEMO_KEEP` | unset | `1` keeps the tmux session and the clone after the scenario. |
| `DEMO_RECORD` | unset | `1` records the `@demo` scenario. `make demo` sets it. |
