# Process tracking signals (issue #33 spike)

Date: 2026-10-13.

This note records what the mod can detect for long-lived runtime artifacts.
The types contract names the core fields:
`Bash.result.backgroundTaskId`, `backgroundedByUser`, `timedOutAfterMs`,
`Monitor.result.taskId`, and notification `task.id`, `task.status`,
`task.toolUseId`
([d.ts](../sources/claude-code-2.1.295/types/claude-code.d.ts#L20348),
[d.ts](../sources/claude-code-2.1.295/types/claude-code.d.ts#L20764),
[d.ts](../sources/claude-code-2.1.295/types/claude-code.d.ts#L14624),
[d.ts](../sources/claude-code-2.1.295/types/claude-code.d.ts#L9826)).

## Signals, reliability and probe cost

| Source | Detect signal | Live state signal | Reliability | Probe cost |
| --- | --- | --- | --- | --- |
| Background Bash | `tool.call` Bash result `backgroundTaskId` | `task-notification` (`task.status`) and `TaskStop` | High | None (event only) |
| Monitor | `tool.call` Monitor result `taskId` | `task-notification` and `TaskStop` | High | None (event only) |
| Docker run / compose up | Parse Bash command (`docker run -d`, `docker compose up -d`) and stdout container id | `docker ps -a` (+ compose label filter) | Medium-high (exact when id or project is known) | Medium |
| tmux / screen | Parse Bash command (`tmux new -d -s`, `screen -dmS`) | `tmux ls`, `screen -ls` | Medium-high (exact when session name is explicit) | Low |
| Detached process | Parse Bash command (a part that ends in `&`, or `setsid -f`) and PID from `echo $!` | `ps -p <pid> -o lstart=,command=`; with no PID, one `ps -A -o pid=,lstart=,command=` lookup by command and start time | Medium (reuse guarded by command fingerprint and start time) | Low-medium |

## What ships now, and what waits

Shipped in this change:

- Background Bash tasks.
- Monitor tasks.
- Docker container and compose project rows.
- tmux and screen session rows.
- Detached process rows, with or without `echo $!`.

## Parsing the Bash command

One Bash call often holds several commands: `docker info; docker run -d ...`
or `mkdir -p d && docker compose -p x up -d`. The parser splits the command
into simple commands first ([`core/lib/shell.ts`](../../../../plugins/artifact-tracking/core/lib/shell.ts)): on `;`, `&&`, `||`,
`|`, `&`, newlines, subshells and groups. Each part is read on its own.

- Quoted text stays one word. So `bash -c '...'`, `ssh host '...'` and
  `echo "...; ..."` start nothing local and are not tracked.
- Heredoc bodies and comments are skipped.
- `VAR=x`, `sudo`, `env`, `nohup`, `time` and `exec` in front are stripped.
- `cd` and `export` move the cwd and env for the parts after them. The Bash
  `tool.call` input has no cwd, so the hook reads `$.session.cwd()`.
- The container id is a stdout line of exactly 64 hex characters. Other hex
  in the output (`docker info` prints commit ids) is not an id.
- A foreground `nohup cmd` (no `&`) is not a detached process.

Probe facts found in manual tests:

- `screen -ls` exits 1 also when sessions exist, and prints the list to
  stdout. The exit code says nothing.
- `tmux ls` with no server exits 1 with `no server running` or
  `error connecting to` on stderr. That means no sessions.
- On macOS `python3 x` shows in `ps` as `.../Python.app/.../Python x`. The
  match compares the program name without folder, case and version digits.

Engine facts found in manual tests (Claude Code 2.1.296):

- A task notification row carries no `task` field on `session.append` or
  in the stored row. In the types `task` is a render prop only. The status
  is in the row text: `<task-id>`, `<tool-use-id>`, `<status>`. Monitor
  notices add an `<event>` tag; the parser ignores it.
- At the hook boundary the row content is an array of blocks. The JSONL
  file stores the same text as one string.
- A subagent's Bash resets its cwd after every call. Only the main loop
  keeps a `cd`, and `$.session.cwd()` follows it there.
- A screen session that a subagent starts died when the subagent ended.
  tmux sessions and Docker containers survived. The probe showed the real
  state (`exited`).

## How a background task ends (issue #56, Claude Code 2.1.304)

A spike hooked `session.append`, `tool.call`, `agent.spawn` and `turn.complete` with a logging mod. It ran a background Bash task in the main loop and in subagents, in headless `claude -p` runs (grade: *verified-kit*, not *verified-live*). The rows below are saved as fixtures in [notices.ts](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts). The spike mod and its raw log are not in the repo, so the fixtures are the saved evidence. The run was on 2.1.304, newer than the newest type snapshot (2.1.302). The `d.ts 302` links show the contract. The fixtures and tests show what the engine did.

| Case | What the mod sees | Evidence |
| --- | --- | --- |
| The session is idle when the task ends | Door `prompt`, origin `task-notification`. The text is the `<task-notification>` block alone. | Fixture `IDLE_NOTICE` [notices.ts:37-49](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L37-L49). Test [processes-tracker.test.ts:459-469](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L459-L469). Types: door set [d.ts 302:10984](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10984), origin [d.ts 302:9246-9250](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9246-L9250). |
| A turn runs when the task ends (the usual case) | Door `delivery`, origin `task-notification`. The engine stores an `attachment` row named `queued_command`. The text is the block inside a `<system-reminder>` wrapper. No `prompt` row follows. | Fixture `MID_TURN_NOTICE` [notices.ts:24-35](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L24-L35). Tests [processes-tracker.test.ts:441-447](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L441-L447), and the wired row shape [register.test.tsx:473-496](../../../../plugins/artifact-tracking/tests/register.test.tsx#L473-L496). Types: `attachment` row and its `name` [d.ts 302:11039-11046](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11039-L11046), `queued_command` [d.ts 302:15244](../sources/claude-code-2.1.302/types/claude-code.d.ts#L15244). |
| The queue | Door `queue`, origin `engine`, the same text. It comes at the enqueue and at the remove. It is no conversation row, so the processes tracker does not read it. | Fixture `QUEUED_NOTICE` [notices.ts:51-61](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L51-L61). Test [processes-tracker.test.ts:486-499](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L486-L499). Types: a queue record is no row of the conversation [d.ts 302:10976-10983](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10976-L10983). The origin `engine` is from the fixture only: the types give none for it. |
| A background subagent's task ends after the agent answered | The engine resumes the agent. Its prompt is the notice: door `prompt`, origin `task-notification`, `agentId`, `isMeta`. | Fixture `AGENT_RESUMED_NOTICE` [notices.ts:63-74](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L63-L74). Test [processes-tracker.test.ts:471-484](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L471-L484). Types: `agentId` of a row [d.ts 302:11015-11021](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11015-L11021), `isMeta` [d.ts 302:11053-11056](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11053-L11056). |
| A task of a foreground subagent | The Bash result has `backgroundEndsWithFinalResponse: true`. The engine ends the task at the agent's final response. No notice follows. | Fixture `BG_START_SYNC_AGENT` [notices.ts:90-106](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L90-L106). Test [processes-tracker.test.ts:501-511](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L501-L511). Types: the flag, for "a synchronous subagent's command, or a headless session" [d.ts 302:21165-21166](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21165-L21166). |

The types and the spike differ on one point (grade: *verified-kit* against *types-only*). A notice folded into a running turn has origin `task-notification` in the spike (second row). The 2.1.302 types say it in two ways. `PromptOrigin` lists `task-notification` for a notification "delivered into a running turn" [d.ts 302:9246-9250](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9246-L9250). `PromptAttachmentOrigin` says such a notification belongs to the engine [d.ts 302:8344-8352](../sources/claude-code-2.1.302/types/claude-code.d.ts#L8344-L8352). The spike saw the first on the `attachment` row. The tracker keys on that origin, so a build that stamps `engine` there would hide the notice. This is open question 38 in [open-questions](../open-questions.md).

Rules that follow:

- The tracker reads doors `prompt` and `delivery`. It matches the origin and the text, never the door alone: the person can type the same text. Code: [index.ts:38-49](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L38-L49) and the door list [index.ts:117](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L117). Tests: a person, a peer, the queue and a model response change nothing [processes-tracker.test.ts:486-499](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L486-L499), typed text changes nothing [register.test.tsx:508-517](../../../../plugins/artifact-tracking/tests/register.test.tsx#L508-L517).
- A row stores the `agentId` of the Bash call and the flag as `endsWithAgent`. `turn.complete` of that agent ends its running flagged rows as `killed`. Code: the row [types.ts:30-36](../../../../plugins/artifact-tracking/trackers/processes/types.ts#L30-L36), [parse.ts:243-264](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L243-L264), the flag read [parse.ts:355-363](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L355-L363), the end [rows.ts:55-64](../../../../plugins/artifact-tracking/trackers/processes/rows.ts#L55-L64) and its handler [index.ts:79-86](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L79-L86). Tests: [processes-tracker.test.ts:501-511](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L501-L511), every end reason [processes-tracker.test.ts:536-543](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L536-L543), a task that already ended stays [processes-tracker.test.ts:559-571](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L559-L571). Types: `agentId` of `turn.complete` [d.ts 302:13967-13974](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13967-L13974), its reasons [d.ts 302:13997](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13997).
- A task of a background subagent has no flag. It survives the agent. Do not kill it: its notice comes later. Fixture `BG_START_ASYNC_AGENT` [notices.ts:108-120](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L108-L120). Test [processes-tracker.test.ts:545-557](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L545-L557).
- The flag is also set for a headless main loop that takes no more input. The same rule ends its rows at the main `turn.complete`. Test [processes-tracker.test.ts:573-585](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L573-L585), wired [register.test.tsx:498-506](../../../../plugins/artifact-tracking/tests/register.test.tsx#L498-L506). Types: [d.ts 302:21165-21166](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21165-L21166).
- A workflow agent is covered (grade: *verified-kit*, a headless `claude -p` run on Claude Code 2.1.304, 2026-10-20). In a one-agent workflow the agent ran `sleep 300` with `run_in_background`. Its `agent.spawn` input had `subagentType: 'workflow-subagent'` and `workflow: { runId, agentIndex }`. Its Bash result had `backgroundEndsWithFinalResponse: true`, and its text said the task "is terminated when you give your final response and no notification can follow that". Its `turn.complete` carried the same `agentId` with reason `answer`, and no notice followed. `/track` on the resumed session showed the row as `killed`. Not seen: when the process died (the headless session ended seconds after the agent). Fixture `BG_START_WORKFLOW_AGENT` [notices.ts:122-144](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L122-L144) holds the Bash result and the agent id. Test [processes-tracker.test.ts:513-534](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L513-L534). Types: `workflow` on `agent.spawn` [d.ts 302:348-378](../sources/claude-code-2.1.302/types/claude-code.d.ts#L348-L378). The value `workflow-subagent` and the `/track` output have no fixture row: the fixture comment and this page are their only record.
- In an interactive session (tmux), a prompt that asks for a foreground subagent still got `Backgrounded agent`. Its `sleep 300` task had no flag, the footer said `1 shell still running`, `ps -A` showed `sleep 300` alive after the agent stopped, and the row stayed `running`, which is true (grade: *verified-live*). A headless `claude -p` run with a foreground subagent set the flag, and `claude -p /track --resume <session>` showed `bg  sleep 300  background task  killed` (grade: *verified-kit*). No fixture holds the interactive run. The full output is in the "Live checks" part of [PR 98](https://github.com/martin-macak/claude-code-mod-tracking/pull/98).

A detached process whose command names a shell variable:

- `ps` shows the command after the shell expanded it. The parser expands the variables that the same Bash call sets (a bare `L=/x`, `export L=/x`) and `$PWD`. A variable lives in the subshell that set it and in the ones below it, like the directory. Code: [parse.ts:268-282](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L268-L282), [parse.ts:376-381](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L376-L381), the scopes [shell.ts:193-213](../../../../plugins/artifact-tracking/core/lib/shell.ts#L193-L213). Tests: [process-parse.test.ts:366-374](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L366-L374), [process-parse.test.ts:379-384](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L379-L384), scopes [process-parse.test.ts:411-422](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L411-L422).
- A word the shell passes as typed is not a reference. `'$F'`, `\$F` and `"\$F"` keep the text `$F`, and `"$F"` and a bare `$F` expand. The splitter drops quotes and escapes from its words, so it also returns each word with a mark on every such `$` (`Segment.marked`). Only the expansion reads the marks. Code: [shell.ts:6-27](../../../../plugins/artifact-tracking/core/lib/shell.ts#L6-L27), the marks [shell.ts:83-99](../../../../plugins/artifact-tracking/core/lib/shell.ts#L83-L99), the read [parse.ts:268-282](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L268-L282), [parse.ts:383-390](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L383-L390), [parse.ts:404-408](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L404-L408), [parse.ts:455-459](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L455-L459). Tests: [process-parse.test.ts:424-441](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L424-L441), a quoted value stays literal when read [process-parse.test.ts:443-450](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L443-L450), other words keep the plain `$` [process-parse.test.ts:452-457](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L452-L457). A stored `$F` is a variable to the probe, so the live process still fits [process-probe.test.ts:135-163](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L135-L163). Without a pid it reads as `unknown` (see the last bullet), never `exited`.
- A name that the command assigns with a command substitution (`D=$(mktemp -d)`, `D=/tmp/run-$(date +%s)`, a backtick) is never expanded. The shell splitter drops the substitution from the word, so the value would read as the wrong literal `/tmp/run-`. The scan is by name over the whole command. A substitution inside quotes stays in the word and does not count. Code: [parse.ts:284-294](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L284-L294). Test: [process-parse.test.ts:395-409](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L395-L409).
- A variable that stays unexpanded makes the probe read that word as a pattern. A variable stands for one word: a value of several words fits nothing. A fingerprint with such a word that fits no process gives the state `unknown`, never `exited`. Code: [probe.ts:103-131](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L103-L131), the state [types.ts:15-16](../../../../plugins/artifact-tracking/trackers/processes/types.ts#L15-L16). Tests: [process-probe.test.ts:135-163](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L135-L163), [process-probe.test.ts:198-204](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L198-L204), [processes-tracker.test.ts:616-633](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L616-L633), [processes-tracker.test.ts:654-661](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L654-L661), and the state at the view [tracker-sections.test.ts:362-380](../../../../plugins/artifact-tracking/tests/tracker-sections.test.ts#L362-L380).
- A fingerprint that names only its program and variables (`node $F`) is never searched in `ps -A`: any process of that program would fit, and the pid would be a guess. The row stays `unknown`. A word with a literal part (`$D/s.js`) is a constraint and is searched. With a pid known (`ps -p`), the loose fingerprint is enough. Code: [probe.ts:163-172](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L163-L172), [probe.ts:191-199](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L191-L199). Tests: [process-probe.test.ts:180-196](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L180-L196), [processes-tracker.test.ts:596-614](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L596-L614), [processes-tracker.test.ts:635-652](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L635-L652).

Not covered: a tmux session on another socket (`-L`, `-S`), a tmux session
with no `-s` name, and a compose project named only by `name:` in its file.

Still waiting:

- Backgrounded shells that the engine itself leaks after hard termination.
  The session does not get a reliable task lifecycle event for that path, so
  the pane can show stale "running" rows until the next explicit probe.
