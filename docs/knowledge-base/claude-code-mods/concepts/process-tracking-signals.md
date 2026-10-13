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
into simple commands first (`hooks/process/shell.ts`): on `;`, `&&`, `||`,
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

Not covered: a tmux session on another socket (`-L`, `-S`), a tmux session
with no `-s` name, and a compose project named only by `name:` in its file.

Still waiting:

- Backgrounded shells that the engine itself leaks after hard termination.
  The session does not get a reliable task lifecycle event for that path, so
  the pane can show stale "running" rows until the next explicit probe.
