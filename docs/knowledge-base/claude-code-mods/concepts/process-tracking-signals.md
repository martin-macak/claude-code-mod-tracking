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
| Detached process | Parse Bash command (`nohup`, `setsid`, trailing `&`) and PID from stdout | `ps -p <pid> -o lstart=,command=` | Medium (PID required; reuse guarded by command fingerprint) | Low-medium |

## What ships now, and what waits

Shipped in this change:

- Background Bash tasks.
- Monitor tasks.
- Docker container and compose project rows.
- tmux and screen session rows.
- Detached process rows when PID is known.

Still waiting:

- Backgrounded shells that the engine itself leaks after hard termination.
  The session does not get a reliable task lifecycle event for that path, so
  the pane can show stale "running" rows until the next explicit probe.
