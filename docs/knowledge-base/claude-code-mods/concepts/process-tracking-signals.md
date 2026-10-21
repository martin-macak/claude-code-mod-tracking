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
| Monitor | `tool.call` Monitor result `taskId` | `task-notification` (a `<status>` when the source ends, the `<event>` text at the deadline), `TaskStop`, and the end of a workflow agent that armed it | High | None (event only) |
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
- `!`, `if`, `while`, `until`, `do`, `then`, `else` and `elif` in front are
  stripped, in any order with the wrappers above: `time ! git push` and
  `! time git push` are both valid shell. A part that is only `done`, `fi` or
  `esac` is no command and makes no row, so `done &` (a backgrounded loop) has
  no row. `$!` after it is the pid of the loop shell, so no earlier background
  command takes it. A backgrounded builtin (`echo x &`, `cd d &`) is the same:
  its shell makes no row, and the pid line that the next `echo $!` prints is
  dropped, so the job after it gets its own pid. Every detector reads the
  command after these words, not only the detached-process one. A variable set
  in a branch applies in text order: the last write wins, as with `&&` and `||`.
  Evidence (grade: *verified-kit* for the parser, not *verified-live*): the
  tests [process-parse.test.ts:587](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L587),
  [:605](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L605),
  [:615](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L615) and
  [:649](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L649)
  pass under `claude plugin test`, and [shell.test.ts:41](../../../../plugins/artifact-tracking/tests/shell.test.ts#L41)
  covers `stripLead`. The shell fact under the builtin rule was run in `bash`
  and `zsh` outside Claude Code (macOS). `bash 3.2.57` with
  `sleep 3 & S=$!; echo x & B=$!; echo "sleep=$S builtin=$B"` printed
  `sleep=96411 builtin=96412`. `zsh 5.9` printed `sleep=98712 builtin=98713`.
  The two pids differ: `$!` after `echo x &` names the echo's shell, not the
  sleep.
- `cd` and `export` move the cwd and env for the parts after them. The Bash
  `tool.call` input has no cwd, so the hook reads `$.session.cwd()`.
- A `cd` in a list that ends with `&` runs in a background subshell and does
  not move the folder of the parts after the `&`. That holds for `cd x &`,
  `cd x && y &`, `{ cd x; } &` and `for ...; do cd x; done &`. A `{` group
  opens a list of its own (`cd x && { y & }` keeps the `cd`). A newline right
  after `&&`, `||` or `|` continues the list.
  Evidence (grade: *verified-kit* for the parser): the tests in
  `repos.test.ts` and `process-parse.test.ts` named "after a cd that runs in
  the background", and a differential run against real `bash` (macOS) of
  random `cd`, `pushd`, `&`, `&&`, `;`, newline, group, subshell and loop
  lists, which showed no difference in the folder of the last command.
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
  notices add an `<event>` tag. A Monitor that reached its deadline has no
  `<status>`: the parser reads its `<event>` instead (see "How a Monitor ends"
  below).
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
| The session is idle when the task ends | Door `prompt`, origin `task-notification`. The text is the `<task-notification>` block alone. | Fixture `IDLE_NOTICE` [notices.ts:38-50](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L38-L50). Test [processes-tracker.test.ts:475-485](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L475-L485). Types: door set [d.ts 302:10984](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10984), origin [d.ts 302:9246-9250](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9246-L9250). |
| A turn runs when the task ends (the usual case) | Door `delivery`, origin `task-notification`. The engine stores an `attachment` row named `queued_command`. The text is the block inside a `<system-reminder>` wrapper. No `prompt` row follows. | Fixture `MID_TURN_NOTICE` [notices.ts:25-36](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L25-L36). Tests [processes-tracker.test.ts:457-463](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L457-L463), and the wired row shape [register.test.tsx:472-495](../../../../plugins/artifact-tracking/tests/register.test.tsx#L472-L495). Types: `attachment` row and its `name` [d.ts 302:11039-11046](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11039-L11046), `queued_command` [d.ts 302:15244](../sources/claude-code-2.1.302/types/claude-code.d.ts#L15244). |
| The queue | Door `queue`, origin `engine`, the same text. It comes at the enqueue and at the remove. It is no conversation row, so the processes tracker does not read it. | Fixture `QUEUED_NOTICE` [notices.ts:52-62](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L52-L62). Test [processes-tracker.test.ts:502-515](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L502-L515). Types: a queue record is no row of the conversation [d.ts 302:10976-10983](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10976-L10983). The origin `engine` is from the fixture only: the types give none for it. |
| A background subagent's task ends after the agent answered | The engine resumes the agent. Its prompt is the notice: door `prompt`, origin `task-notification`, `agentId`, `isMeta`. | Fixture `AGENT_RESUMED_NOTICE` [notices.ts:64-75](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L64-L75). Test [processes-tracker.test.ts:487-500](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L487-L500). Types: `agentId` of a row [d.ts 302:11015-11021](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11015-L11021), `isMeta` [d.ts 302:11053-11056](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11053-L11056). |
| A task of a foreground subagent | The Bash result has `backgroundEndsWithFinalResponse: true`. The engine ends the task at the agent's final response. No notice follows. | Fixture `BG_START_SYNC_AGENT` [notices.ts:91-107](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L91-L107). Test [processes-tracker.test.ts:517-527](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L517-L527). Types: the flag, for "a synchronous subagent's command, or a headless session" [d.ts 302:21165-21166](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21165-L21166). |

The types and the spike differ on one point (grade: *verified-kit* against *types-only*). A notice folded into a running turn has origin `task-notification` in the spike (second row). The 2.1.302 types say it in two ways. `PromptOrigin` lists `task-notification` for a notification "delivered into a running turn" [d.ts 302:9246-9250](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9246-L9250). `PromptAttachmentOrigin` says such a notification belongs to the engine [d.ts 302:8344-8352](../sources/claude-code-2.1.302/types/claude-code.d.ts#L8344-L8352). The spike saw the first on the `attachment` row. The tracker keys on that origin, so a build that stamps `engine` there would hide the notice. This is open question 38 in [open-questions](../open-questions.md).

Rules that follow:

- The tracker reads doors `prompt` and `delivery`. It matches the origin and the text, never the door alone: the person can type the same text. Code: [index.ts:68-79](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L68-L79) and the door list [index.ts:157](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L157). Tests: a person, a peer, the queue and a model response change nothing [processes-tracker.test.ts:502-515](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L502-L515), typed text changes nothing [register.test.tsx:507-516](../../../../plugins/artifact-tracking/tests/register.test.tsx#L507-L516).
- A row stores the `agentId` of the Bash call and the flag as `endsWithAgent`. `turn.complete` of that agent ends its running flagged rows as `killed`. Code: the row [types.ts:35-42](../../../../plugins/artifact-tracking/trackers/processes/types.ts#L35-L42), [parse.ts:243-264](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L243-L264), the flag read [parse.ts:355-363](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L355-L363), the end [rows.ts:87-96](../../../../plugins/artifact-tracking/trackers/processes/rows.ts#L87-L96) and its handler [index.ts:115-122](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L115-L122). Tests: [processes-tracker.test.ts:517-527](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L517-L527), every end reason [processes-tracker.test.ts:552-559](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L552-L559), a task that already ended stays [processes-tracker.test.ts:575-587](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L575-L587). Types: `agentId` of `turn.complete` [d.ts 302:13967-13974](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13967-L13974), its reasons [d.ts 302:13997](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13997).
- A task of a background subagent has no flag. It survives the agent. Do not kill it: its notice comes later. Fixture `BG_START_ASYNC_AGENT` [notices.ts:109-121](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L109-L121). Test [processes-tracker.test.ts:561-573](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L561-L573).
- The flag is also set for a headless main loop that takes no more input. The same rule ends its rows at the main `turn.complete`. Test [processes-tracker.test.ts:589-601](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L589-L601), wired [register.test.tsx:497-505](../../../../plugins/artifact-tracking/tests/register.test.tsx#L497-L505). Types: [d.ts 302:21165-21166](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21165-L21166).
- A workflow agent is covered (grade: *verified-kit*, a headless `claude -p` run on Claude Code 2.1.304, 2026-10-20). In a one-agent workflow the agent ran `sleep 300` with `run_in_background`. Its `agent.spawn` input had `subagentType: 'workflow-subagent'` and `workflow: { runId, agentIndex }`. Its Bash result had `backgroundEndsWithFinalResponse: true`, and its text said the task "is terminated when you give your final response and no notification can follow that". Its `turn.complete` carried the same `agentId` with reason `answer`, and no notice followed. `/track` on the resumed session showed the row as `killed`. Not seen: when the process died (the headless session ended seconds after the agent). Fixture `BG_START_WORKFLOW_AGENT` [notices.ts:123-145](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L123-L145) holds the Bash result and the agent id. Test [processes-tracker.test.ts:529-550](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L529-L550). Types: `workflow` on `agent.spawn` [d.ts 302:348-378](../sources/claude-code-2.1.302/types/claude-code.d.ts#L348-L378). The value `workflow-subagent` and the `/track` output have no fixture row: the fixture comment and this page are their only record.
- In an interactive session (tmux), a prompt that asks for a foreground subagent still got `Backgrounded agent`. Its `sleep 300` task had no flag, the footer said `1 shell still running`, `ps -A` showed `sleep 300` alive after the agent stopped, and the row stayed `running`, which is true (grade: *verified-live*). A headless `claude -p` run with a foreground subagent set the flag, and `claude -p /track --resume <session>` showed `bg  sleep 300  background task  killed` (grade: *verified-kit*). No fixture holds the interactive run. The full output is in the "Live checks" part of [PR 98](https://github.com/martin-macak/claude-code-mod-tracking/pull/98).

## How a Monitor ends (issue #118, Claude Code 2.1.304)

Before issue #118 a Monitor row ended only for a notice with a `<status>` and for `TaskStop`. Two other ends left the row `running` for ever. The facts below come from three sources. The transcript of a real session (fixtures). Headless `claude -p` runs on 2.1.304 with model haiku, a probe mod that logged `agent.spawn`, `tool.call`, `session.append` and `turn.complete`, and this branch's mod (grade: *verified-kit*; 2026-10-20). Interactive tmux runs on 2.1.305 with model haiku, once with the mod of `main` (b3723bf) and once with this branch's mod, with `/track` read from the screen (grade: *verified-live*; 2026-10-20). The probe mod, its raw logs and the tmux probe script are not in the repo, so the fixtures and this page are the saved evidence.

| Case | What the mod sees | Evidence |
| --- | --- | --- |
| The source of the Monitor ends (the command exits) | A notice with `<status>completed</status>`, a `<tool-use-id>` and the last `<event>`. The row ended before #118 and still does. | Fixture `MONITOR_STREAM_ENDED_NOTICE` [notices.ts:195](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L195). Test [processes-tracker.test.ts:648](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L648). Interactive: `main` ended the row too. |
| An output line of a Monitor that goes on | A notice with an `<event>` and no `<status>`, no `<tool-use-id>`. The row must stay `running`. | Fixture `MONITOR_EVENT_NOTICE` [notices.ts:210](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L210). Test [processes-tracker.test.ts:655](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L655). |
| The Monitor reaches its `timeout_ms` | The engine kills the Monitor and sends one notice. It has no `<status>` and no `<tool-use-id>`. The only sign is the `<event>`: `[Monitor expired after 1s with no events delivered. Re-arm it ...]`. The tracker ends the row as `completed` when the `<event>` opens with `[Monitor expired`. A line of Monitor output that opens with the same words also ends its row: no tag tells the two apart. | Fixtures `MONITOR_EXPIRY_NOTICE` [notices.ts:181](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L181) (door `delivery`) and `MONITOR_EXPIRY_NOTICE_IDLE` [notices.ts:188](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L188) (door `prompt`, built from the first). Code: the opening words [parse.ts:555](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L555) and the read [parse.ts:564-572](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L564-L572). Tests: [processes-tracker.test.ts:634](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L634), the parser [process-parse.test.ts:367](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L367), [process-parse.test.ts:380](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L380) and [process-parse.test.ts:386](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L386). Types: the deadline text of `timeout_ms` ("You are notified at expiry and can re-arm") [d.ts 302:17108](../sources/claude-code-2.1.302/types/claude-code.d.ts#L17108). |
| A workflow agent gives its final response while its Monitor is armed | The engine stops the Monitor and sends no notice. | Two headless probe runs and one interactive run, below. Code: the id of the workflow agent [index.ts:105-108](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L105-L108), the flag [index.ts:99](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L99) and its check [index.ts:58-65](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L58-L65). Tests: [processes-tracker.test.ts:685](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L685) and, for the scope of the Set, [processes-tracker.test.ts:764](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L764). |
| A subagent of the Agent tool gives its final response while its Monitor is armed | Nothing ends. The engine says the agent "stopped with background work of its own still running". At the deadline it resumes the agent with the expiry notice as its prompt (door `prompt`, origin `task-notification`, the agent's id, `isMeta`). | Fixture `SUBAGENT_MONITOR_EXPIRY_NOTICE` [notices.ts:263](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L263). Test [processes-tracker.test.ts:704](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L704). |

The probe, in short. A one-agent workflow: the agent armed three Monitors and gave its final response 8 s later. One Monitor ran `while true; do date +%s >> hb.log; sleep 1; done` (`timeout_ms` 120000). The first run:

- The Monitor was armed at 7.6 s. The agent's `turn.complete` (reason `answer`) came at 16.0 s.
- `hb.log` got 9 lines, the last one at the second of that `turn.complete`. The main loop read the file 11 s later (`wc -l` said 9, the last line unchanged). `ps` showed no loop left.
- No notice for the task came, neither with a `<status>` nor an expiry notice. The other two Monitors (a source that ended, a 1 s deadline) sent theirs while the agent was alive.
- A second run, with this branch's mod, gave the same: 9 lines, the file stopped at the agent's `turn.complete`.

The same probe with a background subagent (`run_in_background: true`) and with a subagent that the call did not set to background: the file kept growing for the whole `timeout_ms` (119 and 20 lines for 2 min and 20 s), and the expiry notice came at the deadline. The Monitor of a subagent survives the agent. A subagent of the Agent tool that is truly synchronous was not seen: the call without `run_in_background` came back at once in both runs.

What the hook sees for the workflow agent: `agent.spawn` has `workflow: { runId, agentIndex }` and `subagentType: 'workflow-subagent'` in its input, and the answer of `next(e)` has `agentId`. The Monitor result is `{ taskId, timeoutMs, persistent }`. It has no flag like `backgroundEndsWithFinalResponse`, and the start text says only "expires in 2m unless the source ends first; you get one notice at expiry". So the tracker learns the workflow agents from `agent.spawn` and flags the Monitor rows of those agents (`endsWithAgent`). `turn.complete` of the agent then ends them as `killed`: the engine stopped them, as for a flagged Bash task.

After a reload the tracker has not seen the spawn of an agent that started before it: module variables reset ([gotchas](../gotchas.md), item 10) and `agent.spawn` is not replayed. So a Monitor of an agent that the set lacks is also checked against the engine's agent list ([index.ts:58-65](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L58-L65)). The list names the subagents and teammates, not a workflow's agents ([d.ts 302:3262-3268](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3262-L3268)), so an agent that the list does not name is a workflow's, and its Monitor gets the flag. A list that cannot be read gives no flag. Tests: [processes-tracker.test.ts:739](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L739), [processes-tracker.test.ts:751](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L751). Interactive check (Claude Code 2.1.305, grade: *verified-live*; one run): a copy of this branch's mod named each Monitor row after the list at the call. The agent of a workflow was not in the list (the row ended as `killed`), the agent of a background subagent was in it (the row stayed `running`), and the main loop has no agent id.

Headless check of the whole path (one `claude -p` run with a workflow agent and a background subagent, then `claude -p /track --resume <session>`; grade: *verified-kit*):

```text
main b3723bf                           this branch
  monitor  Monitor  monitor  completed    monitor  Monitor  monitor  completed   source ended
  monitor  Monitor  monitor  running      monitor  Monitor  monitor  killed      workflow agent ended
  monitor  Monitor  monitor  running      monitor  Monitor  monitor  completed   1 s deadline
  monitor  Monitor  monitor  running      monitor  Monitor  monitor  completed   background subagent, 8 s deadline
```

Interactive checks (Claude Code 2.1.305, tmux, model haiku, `--allowedTools Monitor,Bash,ToolSearch,Workflow,Agent`; grade: *verified-live*; 2026-10-20). One session per mod: the mod of `main` (b3723bf) and this branch's. Each session ended with `/track`, and the Processes rows below are the screen. The pane did not list the rows in the order they were armed, so the states are not mapped to the Monitors one by one. The states follow from the code: the Monitor with a `<status>` is the only one that `main` can end.

- The main loop armed three Monitors, one by one. (1) A 1 s deadline in an idle session: the turn ended, and the expiry notice resumed the session. (2) A source that ends after 2 s. (3) A 1 s deadline while a `sleep 8` Bash call ran: the notice was folded into the running turn.
- A workflow of one agent armed three Monitors, ran `sleep 8` and answered. (1) `sleep 120` with a 120 s `timeout_ms`, still armed at the agent's end. (2) A 1 s deadline. (3) A source that ends after 2 s. `/track` ran after the workflow had ended.

```text
Main loop, three Monitors
  main b3723bf                           this branch
  monitor  Monitor  monitor  running     monitor  Monitor  monitor  completed
  monitor  Monitor  monitor  completed   monitor  Monitor  monitor  completed
  monitor  Monitor  monitor  running     monitor  Monitor  monitor  completed

Workflow agent, three Monitors
  main b3723bf                           this branch
  monitor  Monitor  monitor  running     monitor  Monitor  monitor  completed
  monitor  Monitor  monitor  running     monitor  Monitor  monitor  completed
  monitor  Monitor  monitor  completed   monitor  Monitor  monitor  killed
```

On this branch the band read `Processes 3 (1 ✗)` after the workflow run: the `killed` row. `ps -A` after that run showed no `sleep 120`, so the engine had stopped the Monitor armed at the agent's end (it sent no notice). It still showed the `sleep 30` of the 1 s deadline, 26 s after it started: the deadline ends the Monitor, not the process behind it. That is one observation, not a rule.

Why the end with a workflow agent is `killed` and the deadline is `completed`. A deadline is the bound the caller set. A Monitor that the engine stops at its agent's final response was cut short, as a flagged Bash task is (issue #98), so `killed` is true. `applyAgentEnd` sets it ([rows.ts:95](../../../../plugins/artifact-tracking/trackers/processes/rows.ts#L95)), and `sections.ts` draws `killed` red and counts it in the band ([sections.ts:24](../../../../plugins/artifact-tracking/trackers/processes/sections.ts#L24)). Since issue #49 a `killed` row also stays visible for `failedTtlMs` (1 h by default), and a `completed` one for `endedTtlMs` (30 min): `states.ts` puts `killed` in the failed kind. A workflow that arms many Monitors for its whole run adds one red row for each. If that proves noisy, end the Monitor kind as `completed` in `applyAgentEnd` and change the state in the test [processes-tracker.test.ts:685](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L685).

Not known. Open question 40 holds the first five.

- A synchronous subagent, or the main loop of a headless session, with an armed Monitor: the probes did not see them (the Agent call came back at once in both runs). They get no flag, so their rows stay `running` until a notice or `TaskStop`.
- A `persistent: true` Monitor of a workflow agent. The type says it "runs until TaskStop or session end" ([d.ts 302:21567-21568](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21567-L21568)). The probes armed none, so the engine may not stop it with the agent. The tracker flags it all the same, so its row ends as `killed` at the agent's end.
- The retry of a stalled workflow agent. `next` settles with the first attempt's `agentId` and the retry "is not raised again" ([d.ts 302:356-357](../sources/claude-code-2.1.302/types/claude-code.d.ts#L356-L357)). The retry has another id and no `agent.spawn`, so its Monitors get no flag and stay `running`.
- Whether the list always names a running subagent at its first Monitor call. The check after a reload relies on it: one interactive run saw the subagent listed. A subagent that the list did not name yet would get `killed` at its end while its Monitor runs on.
- A Monitor that delivered events before its deadline. Both expiry notices seen say "with no events delivered". The anchor is the shorter `[Monitor expired`, but no run has shown the text of that case.
- The count of issue #118: 47 Monitors, 43 notices with `<status>completed</status>`, 44 rows that stayed `running`. The interactive run on `main` ended a row for such a notice, so the two causes above do not explain 43 ended notices next to 44 stuck rows. The count came from a read of a transcript, not from a run. A lead, not a finding: open question 37. Every interactive run printed once that the `session.append` hook of the mod was skipped for an event because another plugin ran first. The rows still ended in these runs.

A detached process whose command names a shell variable:

- `ps` shows the command after the shell expanded it. The parser expands the variables that the same Bash call sets (a bare `L=/x`, `export L=/x`) and `$PWD`. A variable lives in the subshell that set it and in the ones below it, like the directory. Code: [parse.ts:268-282](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L268-L282), [parse.ts:376-381](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L376-L381), the scopes [shell.ts:193-213](../../../../plugins/artifact-tracking/core/lib/shell.ts#L193-L213). Tests: [process-parse.test.ts:409-417](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L409-L417), [process-parse.test.ts:422-427](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L422-L427), scopes [process-parse.test.ts:454-465](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L454-L465).
- A word the shell passes as typed is not a reference. `'$F'`, `\$F` and `"\$F"` keep the text `$F`, and `"$F"` and a bare `$F` expand. The splitter drops quotes and escapes from its words, so it also returns each word with a mark on every such `$` (`Segment.marked`). Only the expansion reads the marks. Code: [shell.ts:6-27](../../../../plugins/artifact-tracking/core/lib/shell.ts#L6-L27), the marks [shell.ts:83-99](../../../../plugins/artifact-tracking/core/lib/shell.ts#L83-L99), the read [parse.ts:268-282](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L268-L282), [parse.ts:383-390](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L383-L390), [parse.ts:404-408](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L404-L408), [parse.ts:455-459](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L455-L459). Tests: [process-parse.test.ts:467-484](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L467-L484), a quoted value stays literal when read [process-parse.test.ts:486-493](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L486-L493), other words keep the plain `$` [process-parse.test.ts:495-500](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L495-L500). A stored `$F` is a variable to the probe, so the live process still fits [process-probe.test.ts:135-163](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L135-L163). Without a pid it reads as `unknown` (see the last bullet), never `exited`.
- A name that the command assigns with a command substitution (`D=$(mktemp -d)`, `D=/tmp/run-$(date +%s)`, a backtick) is never expanded. The shell splitter drops the substitution from the word, so the value would read as the wrong literal `/tmp/run-`. The scan is by name over the whole command. A substitution inside quotes stays in the word and does not count. Code: [parse.ts:284-294](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L284-L294). Test: [process-parse.test.ts:438-452](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L438-L452).
- A variable that stays unexpanded makes the probe read that word as a pattern. A variable stands for one word: a value of several words fits nothing. A fingerprint with such a word that fits no process gives the state `unknown`, never `exited`. Code: [probe.ts:103-131](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L103-L131), the state [types.ts:15-16](../../../../plugins/artifact-tracking/trackers/processes/types.ts#L15-L16). Tests: [process-probe.test.ts:135-163](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L135-L163), [process-probe.test.ts:198-204](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L198-L204), [processes-tracker.test.ts:797-814](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L797-L814), [processes-tracker.test.ts:835-842](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L835-L842), and the state at the view [tracker-sections.test.ts:362-380](../../../../plugins/artifact-tracking/tests/tracker-sections.test.ts#L362-L380).
- A fingerprint that names only its program and variables (`node $F`) is never searched in `ps -A`: any process of that program would fit, and the pid would be a guess. The row stays `unknown`. A word with a literal part (`$D/s.js`) is a constraint and is searched. With a pid known (`ps -p`), the loose fingerprint is enough. Code: [probe.ts:163-172](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L163-L172), [probe.ts:191-199](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L191-L199). Tests: [process-probe.test.ts:180-196](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L180-L196), [processes-tracker.test.ts:777-795](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L777-L795), [processes-tracker.test.ts:816-833](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L816-L833).

Not covered: a tmux session on another socket (`-L`, `-S`), a tmux session
with no `-s` name, and a compose project named only by `name:` in its file.

Still waiting:

- Backgrounded shells that the engine itself leaks after hard termination.
  The session does not get a reliable task lifecycle event for that path, so
  the pane can show stale "running" rows until the next explicit probe.
