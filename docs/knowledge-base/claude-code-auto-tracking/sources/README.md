# Sources

Verbatim outputs of the research runs on 2026-10-10. Never edit them. To refresh, add a new versioned folder.

| Folder | Holds |
| --- | --- |
| `git-2.56.0/` | `git worktree list --porcelain` sample, the heuristics experiment (setup script, results, prototype), command costs, git hooks on worktree add and remove, an `fs.watch` observation |
| `gh-2.102.0/` | Read-only `gh` runs against `martin-macak/claude-code-mod-tracking`: PR lists by head branch and by search, the JSON field list, aliased GraphQL cost, base filter with `closingIssuesReferences`, a conditional REST request (304), a PR body sample, the rate limit |
| `claude-code-2.1.296/` | `claude --help`, `claude agents --help`, probes of how `claude -w` and the Agent tool make worktrees, the structure of the session registry and of transcripts (keys only, other sessions redacted) |
| `live-probe-2026-10-10/` | A scratch probe mod, two recorded event logs, the debug-log lines about the managed bypass, the `gh pr create` tool result, and the scripts to repeat the runs (`repro/`) |
| `live-probe-2026-10-20-workflow-worktrees/` | The journal position and the `worktreePath` of each agent of four saved workflow runs (`workflow-agent-worktree-paths.txt`), and the porcelain records, lock, start point and `meta.json` keys of workflow agent worktrees (`workflow-agent-worktree-porcelain.txt`). Command outputs only: other repos and prompts are not saved. |
| `live-probe-2026-10-10-review/` | The review stage's re-runs of the same probe: two concurrent sessions (`$.store` and `ListAgents`), and a debug-log extract of an `EnterWorktree` plus isolated-agent run. Scratch paths are replaced by `<scratch>`. See its own `README.md`. |

## Provenance and scrubbing

- The probe mod ran in a scratch repo with a local fake Messages API (scripted tool calls, no model spend). The Claude Code binary was 2.1.295 for the probe and 2.1.296 for the runtime probes.
- `live-probe-2026-10-10/debug-managed-bypass-extract.txt` is `grep -n "MDM settings found\|seated outermost\|bypassed by"` over the first debug log. The full log holds machine settings and was not saved.
- `live-probe-2026-10-10/gh-pr-create-tool-result.jsonl` is `jq -c 'select(.toolUseResult.gitOperation != null) | .toolUseResult'` over the probe transcript. The `gh` call was a shim that prints a fixed URL. No PR was created.
- `live-probe-2026-10-20-workflow-worktrees/workflow-agent-worktree-paths.txt` and `workflow-agent-worktree-porcelain.txt` hold the command and its output, as the commands printed them. The changes are the home folder written as `~`, `<pid>` for a process id, and, for the run of another repo, only the last part of each path. The paths file reads the `started` lines of `journal.jsonl` and the `worktreePath` of each `meta.json`. It does not read the prompts or the agent results. Agent labels are kept. The order of the `agent()` calls in the script of run `wf_0b519c0a-08c` comes from the script text in the session transcript. That text holds the prompts, so it is not saved. `worktrees.md` says so where it uses that order.
- `live-probe-2026-10-10/events-run1.jsonl` and `events-run2.jsonl` are the probe mod's own logs. They hold scratch paths and session ids of throwaway runs.
- `live-probe-2026-10-10/repro/` copies the scripts. `run.sh` points to a scratch folder and the 2.1.295 binary. Edit the paths before you reuse it. `seqA.json` and `seqB.json` drive `fake2.mjs` (roles `main` and `sub`). `seq1.json` drives `fake-api.mjs`.
- `claude-code-2.1.296/claude-session-registry-and-transcript-structure.txt` lists keys only. Names and paths of other sessions are redacted. No `.key` file was read.
- `gh-2.102.0/` omits the raw REST payload (23 KB of response headers and an account-bound body). `gh-rest-conditional-304.txt` keeps the status lines and rate-limit headers.
- A scan for `ghp_` and `gho_` prefixes, `github_pat`, bearer strings, email addresses, `authorization` and `secret` found only: the dummy identity `t@example.com` in a setup script, the literal `ANTHROPIC_AUTH_TOKEN=fake` in `repro/run.sh`, and the words "non-secret subset" in a comment.
