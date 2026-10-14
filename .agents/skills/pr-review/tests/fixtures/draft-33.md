## Design draft for this feature

This comment holds the spike result and a design that an agent can build from. It is based on live probes on Claude Code **2.1.296** (types file 2.1.295), macOS, Docker 29.5.3 (Rancher Desktop), tmux 3.8 and GNU screen.

**Verdict:** you can build all five sources. Engine shells and Docker are exact. tmux and screen are exact when Claude names the session. Detached processes need a heuristic, but the heuristic has tight bounds. One gap stays open: shells that the engine leaks when it is killed (see G6).

<details>
<summary>How the spike was run</summary>

- A probe mod logged every `tool.call`, every `session.append` (door, origin, content), `ui.render` of `UserMessage` rows, and `session.end`. A 3 s timer ran the refresh probes through `$.process.run` and timed them.
- A fake Messages API played a fixed list of tool calls, so no real model ran. It is the same method as the auto-tracking probe (#5).
- Four runs: headless (`-p`), headless killed by a signal, `--resume` of that session, and interactive in a private tmux server (Ctrl+B, an idle notification, `/exit`).
- The probe mod, the fake API, the turn scripts and the event logs are saved, untracked, under `docs/knowledge-base/claude-code-process-tracking/sources/live-probe-2026-10-13/`. The implementing PR must commit them with a KB note. That is the spike criterion of this issue. All observed shapes that the design needs are copied below, so this comment stands alone.

</details>

### 1. Feasibility per source

| Source | Verdict | Detect | Live state | Ends when |
| --- | --- | --- | --- | --- |
| Background Bash (`run_in_background`) | **Feasible** | `tool.call` Bash result `backgroundTaskId` | Notification only. No probe can see it. | Notification, `TaskStop`, session exit |
| Ctrl+B by the user | **Feasible** | Same, plus `backgroundedByUser: true` | Same | Same |
| Bash `timeout` reached | **Not observed** | `timedOutAfterMs` is in the types file | — | The command was **killed** (exit 143) in both `-p` and interactive mode. Handle the field if it appears. Do not test it. |
| Monitor | **Untested** | Result `taskId` (types file) | Notification, same as a shell | The tool was disabled in the probe ("No such tool available"). Treat it like a shell. No acceptance criterion depends on it. |
| `docker run -d` | **Feasible** | Parse the command. Container ID = first 64-hex line of stdout. | `docker ps -a --no-trunc --format '{{json .}}'` | Exited, removed (`--rm`), daemon gone |
| `docker compose up -d` | **Feasible** | Parse the command. Container names from `Container <name> Started` lines. | Same probe. Project from the `com.docker.compose.project` label. | All containers exited or removed |
| `tmux new-session -d` | **Feasible** (named), **Heuristic** (unnamed) | Parse the command for `-s`, `-L`, `-S` | `tmux [-L x] ls -F '#{session_name} #{session_created}'` | Session gone, or "no server running" |
| `screen -dmS` | **Feasible** (named only) | Parse the command for `-S` | `screen -ls` | Name gone, or "No Sockets found" |
| `nohup …&`, plain `&`, `disown`, `setsid` | **Heuristic** | `ps` sweep after the call (see 3.4) | `ps -p <pids> -o pid=,lstart=,command=` | PID gone, or PID reused (start time changed) |

What happens to each source when the session ends, as observed:

| Kind | Clean `/exit` | `-p` ends | Claude is killed (signal) | `--resume` |
| --- | --- | --- | --- | --- |
| Engine shell | `/exit` asks: "Exit and stop tasks", "Move to background and exit", "Stay". "Exit and stop tasks" killed it. | `-p` **waits** for running shells before it exits. | **Leaks.** The shell moves to PID 1 and keeps running. | The engine appends a notification `status=stopped`, "didn't finish before the previous session ended … No completion record was found". It reports from its records, not from a check of the process. (In the probe the leaked process was killed by hand before the resume, so a resume with the orphan still alive is untested.) |
| Container, tmux, screen, `nohup`/`&` | Survives | Survives | Survives | Survives |

So the "leftovers" pain is about containers, terminal sessions and detached processes. Engine shells are a leftover only after a crash or a kill.

### 2. Spike problems, resolved
