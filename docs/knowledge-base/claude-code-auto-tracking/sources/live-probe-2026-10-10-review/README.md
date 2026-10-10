# Review probe, 2026-10-10

The review stage re-ran the probe mod from [`../live-probe-2026-10-10/`](../live-probe-2026-10-10/) to check the KB claims. Same binary (2.1.295), same fake Messages API (`repro/fake2.mjs`), same isolated `CLAUDE_CONFIG_DIR`. Scratch paths are replaced by `<scratch>`.

| File | What it shows |
| --- | --- |
| `concurrent-A-ev-2aceba68.jsonl` | Session A in `<scratch>/repo`. Started 3 s before B. Its 1 s tick wrote `p:<own id>` to `$.store` and listed all keys. Its `ListAgents` call ran every 3 s. |
| `concurrent-B-ev-837491f5.jsonl` | Session B in `<scratch>/repoB`, a different repository, at the same time. |
| `seq2.json` | The fake-API script of the debug run: `EnterWorktree`, then `Agent` with `isolation: "worktree"` and `run_in_background`, then `ExitWorktree {action: "remove"}`. |
| `debug-extract-seq2.txt` | Matching lines of the `--debug-file` log of the `seq2.json` run. |

Read-outs:

- B wrote its first `p:` key at `at=1791650746503`. A listed it at `1791650747513`, on its next tick. Cross-process visibility of `$.store` within one tick is observed.
- `ListAgents` in A listed B as `{kind: "sessions", rows: [{name: "repob-63", ref: "283b75", type: "interactive", status: null}]}` and then with `status: "busy"`. B listed A the same way. The two sessions were in **different repositories**. `ListAgents` does not filter by repository.
- A listed B through `ListAgents` 3 ms before B's own `session.start` hook ran. So `ListAgents` likely does not need the mod in the peer (the hook time is not the process start).
- Debug lines 296 to 302: the managed `cc-plugin-sec-default` module hooks `classic.WorktreeCreate`, calls `next()` with no `worktreePath`, and git still creates the worktree.
- Debug lines 301 and 353: with an `origin` remote that cannot be fetched, Claude Code logs `fetch of origin/main failed — basing worktree on local HEAD`.
- Debug line 354: the agent worktree was made while the session was inside `probe-wt`. It still landed at `<scratch>/repo/.claude/worktrees/agent-<id>`, under the main working tree, not under `probe-wt`.
- Debug lines 535 to 542: `ExitWorktree {action: "remove"}` removes the directory and deletes the branch `worktree-probe-wt`.
- The probe hooked `classic.WorktreeRemove` and `classic.CwdChanged`. The log has no line for either.
