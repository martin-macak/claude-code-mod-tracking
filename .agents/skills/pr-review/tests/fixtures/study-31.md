## Design study: Track other repositories that the session visits

**Overall: Go with caveats** (weighted mean 74/100). Every `Must` item rests on a probe run (R1–R7) or on a passing repo test of the pattern it copies (R8–R10, Evidence 4); the weak end is the Bash-based detection (R2, R12, R13), which parses or guesses.
Not tested: the built feature (live check in §7), `LSP` with the tool enabled (R15), a workflow `agent.spawn` with a `cwd` (R14), Linux paths for the noise filter.

> Evidence, probe code, observed shapes and the Jev judgments are in the next comment ("Design study evidence"). File names in backticks below refer to it.

<details><summary>How the study was run</summary>

- Versions: Claude Code 2.1.296, git 2.56.0, macOS. The machine has managed settings (`cc-plugin-sec-default` seated outermost) (debug extract, lines 3–4 (`debug-extract.txt`)).
- Method: the fake-API probe harness of the auto-tracking slug. A fake Messages API plays a fixed list of tool calls; a probe mod logs every `tool.call` (input, `agentId`, result shape, `$.session.cwd()` before and after `next(e)`), `agent.spawn`, `classic.CwdChanged`, and times `git` through `$.process.run`. No model, no login.
- Workspace: throwaway repos in the scratchpad: `root` (origin `acme/root`) with worktree `root-wt`; `other` (origin `https://github.com/acme/other.git`) with worktree `other-wt` and a clone `other-clone` (origin `git@github.com:acme/other.git`); `noremote` (unborn branch `dev`, no remote); `plain` (no git).
- Runs: run 1 file tools, Bash, a subagent; run 2 `cd` with `--add-dir`, `LSP`, `NotebookEdit`; run 3 `$.env.get`. Logs and probe code: the evidence comment below. Git edge cases by hand: git-edge-cases.txt.
- Live check during the study: not needed. No tool under study needs a claude.ai backend. Deciding claims are observed (Evidence 5) or rest on the types file and passing repo tests (Evidence 4: R8–R11, R14, R15). The built feature still needs the live check in §7.
- Types file cited as `d.ts:<line>`: `docs/knowledge-base/claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts` in this repo.
- Reviewers: the `advisor` tool before the design (step 6); an independent `opus` subagent after it (step 10).
- Decision model: TypeSafe Jev (`jev-1.13.0`), one `jev_ask` per item for Ease, Safety and the verdict. Judgments below. Arithmetic: `scripts/score.mjs`.

</details>

### 1. Score

Output of `node .agents/skills/design-study/scripts/score.mjs`:

**#31 Track other repositories that the session visits**

| Rank | Item | Priority | Verdict | Evidence | Ease | Safety | Score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | R12 Read or edit mark | Should | Heuristic | 5 | 4 | 3 | 43 |
| 2 | R13 Bash absolute path args as weak read | Could | Heuristic | 5 | 4 | 3 | 43 |
| 3 | R2 Shell: cd, git -C, gh -R | Must | Partial | 5 | 3 | 3 | 60 |
| 4 | R14 agent.spawn cwd outside root | Should | Partial | 4 | 4 | 4 | 60 |
| 5 | R15 LSP filePath | Could | Partial | 4 | 4 | 4 | 60 |
| 6 | R1 File tools (Read, Edit, Write, NotebookEdit) | Must | Partial | 5 | 3 | 4 | 63 |
| 7 | R10 Repos section, band, row fields | Must | Feasible | 4 | 3 | 3 | 70 |
| 8 | R8 Per-dir cache and circuit breaker | Must | Feasible | 4 | 3 | 4 | 74 |
| 9 | R9 /track clear, stored copy, empty band | Must | Feasible | 4 | 3 | 4 | 74 |
| 10 | R11 Dismiss for the run | Should | Feasible | 4 | 4 | 4 | 80 |
| 11 | R3 Subagent attribution | Must | Feasible | 5 | 3 | 4 | 84 |
| 12 | R5 Exclude root, its worktrees and clones | Must | Feasible | 5 | 4 | 3 | 86 |
| 13 | R4 Group by origin remote | Must | Feasible | 5 | 4 | 4 | 90 |
| 14 | R6 Noise filter | Must | Feasible | 5 | 4 | 4 | 90 |
| 15 | R7 Non-git path adds nothing | Must | Feasible | 5 | 4 | 4 | 90 |

**Overall: Go with caveats** (mean 55-74). Weighted mean: 74/100. Items are ranked weakest first.

No item was lowered by the evidence rule: every `Feasible`, `Partial` and `Heuristic` item has Evidence ≥ 4.

### 2. Feasibility per item

| Item | Priority | From |
| --- | --- | --- |
| R1 A `Read`, `Edit`, `Write` or `NotebookEdit` call on a path in another repo adds one row | Must | AC 1 |
| R2 `cd`, `git -C` and `gh -R` in a Bash call add a row | Must | AC 2 |
| R3 A row shows which agents touched the repo | Must | AC 3 |
| R4 Many paths, worktrees or clones of one repo give one row, grouped by remote | Must | AC 4 |
| R5 The root repo, its worktrees and its clones never appear | Must | AC 5, user |
| R6 `~/.claude*`, `/tmp`, scratchpad, `node_modules`, plugin caches never appear | Must | AC 6 |
| R7 A path outside any git repo adds nothing | Must | AC 7 |
| R8 Resolution is cached per dir and capped by a breaker; a failed `git` adds nothing and breaks nothing | Must | AC 8 |
| R9 `/track clear` and the stored copy handle repos; the band is empty when nothing is tracked | Must | AC 9 |
| R10 Repos section, band segment `Repos n`, row with name, branch and agents | Must | Display |
| R11 The `x` button hides a repo for the rest of the run | Should | User |
| R12 Each row is marked `read` or `edit` | Should | User |
| R13 Absolute path arguments of a Bash command count as a weak `read` | Could | User |
| R14 An `agent.spawn` with a `cwd` outside the root adds a row | Should | Sources list |
| R15 An `LSP` call with a `filePath` in another repo adds a row | Could | Replaces Grep and Glob |

The ACs "Tests cover …" and "README lists the new rows" are work items, not feasibility items. The test plan in §7 below covers them.

| Item | Verdict | Mechanism | Caveat | Evidence |
| --- | --- | --- | --- | --- |
| R1 | Partial | Hook `tool.call` for the four tools. Path from `file_path` or `notebook_path`. Skip `isError` and `deny`. Resolve a relative path against `$.session.cwd()` read **before** `next(e)`. Queue the dir; resolve off the hook. | A relative path from a subagent is skipped: its base dir is unknown. | `[observed]` run 1 L2–L13 (`events-run1.jsonl`) (paths, `isError` with a string result on L7); run 2 L4 (`events-run2.jsonl`) (relative `README.md` read from the moved cwd), L7 (`events-run2.jsonl`) (`notebook_path`). |
| R2 | Partial | `splitShell` + `stripWrappers`. Walk simple commands with a virtual cwd: `cd`/`pushd` move it, `git -C X` names a dir, `gh -R`/`--repo [HOST/]OWNER/REPO` names a slug. | Not seen: commands inside quotes (`bash -c '…'`, `ssh`), `$VAR` paths, relative targets in a subagent. `splitShell` splits on `(` and `$(`, so a `cd` inside a subshell `(cd x && make)` leaks into the later commands. | `[observed]` run 1 L20–L26 (`events-run1.jsonl`): input has `command` only, no cwd; `cd ../other && git branch` printed `main` and "Shell cwd was reset"; subagent `cd ../noremote && pwd` printed the noremote dir L31 (`events-run1.jsonl`). |
| R3 | Feasible | `e.agentId` on `tool.call` names the loop; absent on main. Label from the `auto` atom's `AgentProof.label`, else the short id. | None for attribution. Relative-path limits sit in R1 and R2. | `[observed]` run 1 L28 (`events-run1.jsonl`) spawn answer `agentId`, the same id on the subagent's `Read` and `Bash` L30–L32 (`events-run1.jsonl`). |
| R4 | Feasible | Key `<host>/<owner>/<repo>` from `parseRemote(git config --get remote.origin.url)` (it lowercases the host), then lowercase owner and repo. No remote or unparsable: `local:<absolute common dir>`. | A fork and its upstream are two rows (different remotes). | `[observed]` git-edge-cases.txt: `config --get` gives `https://github.com/acme/other.git` for `other` and `other-wt`, `remote get-url` gives the `insteadOf`-rewritten `ssh://git@github.com/acme/other.git`; run 1 L18 (`events-run1.jsonl`): `other-clone` gives `git@github.com:acme/other.git`. All three forms parse to `acme/other`. `[primary source]` `parseRemote` and its tests. |
| R5 | Feasible | Resolve the root once. Drop a checkout whose absolute common dir equals the root's, or whose key equals the root's key. A path under `root.top` skips `git`. | If the root cannot be resolved, only the prefix check applies. | `[observed]` run 1 L16 (`events-run1.jsonl`): `root-wt` has common dir `root/.git`; git-edge-cases.txt: `--path-format=absolute`. |
| R6 | Feasible | Pure filter on the input path **and** on the resolved toplevel: `$HOME/.claude*`, `$CLAUDE_CONFIG_DIR`, `$HOME/.local/share/claude`, `/tmp`, `/private/tmp`, `$TMPDIR`, `/var/folders`, any `node_modules` segment. | Other caches (`~/.cache`, vendor dirs) are out of scope. | `[observed]` run 3 L1 (`events-run3.jsonl`): `$.env.get` gives `HOME`, `TMPDIR`, `CLAUDE_CONFIG_DIR`; run 1 L19 (`events-run1.jsonl`): a `node_modules` file resolves to its parent repo, so filter first. |
| R7 | Feasible | `git -C <dir> rev-parse` exits non-zero: cache a negative answer, write nothing. | None. | `[observed]` run 1 L14 (`events-run1.jsonl`) exit 128; git-edge-cases.txt missing dir exit 128. |
| R8 | Feasible | `RepoResolver`: per-dir cache, in-flight map, serial queue drained after the hook, 5 s timeout, own `CircuitBreaker`. Only a rejection or timeout trips it. | Evidence for the breaker is the repo's own tests, not a run. | `[observed]` run 2 L5 (`events-run2.jsonl`): a bad `cwd` option rejects; `-C` exits 128. `[primary source]` `$.process.run` rejects on no start or timeout (d.ts:3504). Repo tests: `circuit-breaker.test.ts`. |
| R9 | Feasible | Copy the `processes` pattern: atom, mirror, `s:<id>.repos` in `$.store`, carry over `/clear`, restore on `/resume`, empty on `/track clear`. | Not run for repos. | Passing repo tests of the same path (`register.test.tsx`: "/clear carry-over also keeps tracked processes…", "/resume of a known session restores…", "/track clear empties the list…"). |
| R10 | Feasible | Pure `ui/repos-view.ts` like `ui/process-view.ts`. `composePane` and `composeBand` add it. Branch from `git branch --show-current`, refreshed on the 30 s tick. | A branch can be one tick stale. A `gh -R` row has no branch. | Passing repo tests of the same pattern: `view.test.ts`, `band.test.tsx`, `process-view.test.ts`. `[observed]` `branch --show-current` on an unborn branch (git-edge-cases.txt). |
| R11 | Feasible | Row id `rp:<key>`. `dismissOne` (`register.tsx`) adds it to `auto.dismissed` through `dismiss` (`auto/dismiss.ts`); `isRowId` learns `rp:`. | Hidden until the process ends, also on new use (user choice). | Passing repo test `dismiss.test.ts`. |
| R12 | Heuristic | `Edit`, `Write`, `NotebookEdit` and `git -C X <write subcommand>` mark `edit`. All else `read`. `edit` wins. | Bash writes without `git` (`sed -i`, `cp`, `>`) read as `read`. | `[observed]` tool names and inputs, runs 1–2. |
| R13 | Heuristic | Words that start with `/` or `~/` (not the command word, not in `echo`/`printf`), filtered, then `git -C <word>`; on "Not a directory", its parent. | Guesses use from a mention: `--flag=/path`, paths for other tools. `$VAR` paths are missed. | `[observed]` Bash input is the raw command (L20 (`events-run1.jsonl`)); `git -C <file>` exits 128 "Not a directory" (git-edge-cases.txt). |
| R14 | Partial | In the existing `agent.spawn` hook, queue `SpawnFacts.cwd` with the new agent id. | The model's `Agent` tool has no `cwd` parameter and its spawn carried none. Per the types, only a call that sets one (workflow agents, plugin `$.agent.spawn`) has a `cwd`. `[inference]` for the workflow case. | `[observed]` run 1 L27 (`events-run1.jsonl`): no `cwd` for an `Agent` call. `[primary source]` d.ts:387, Agent input. |
| R15 | Partial | Same path as R1, field `filePath`. | Only when the user enables the LSP tool. | `[primary source]` LSP input. `[observed]` "Unknown tool LSP" when not enabled (debug extract L40 (`debug-extract.txt`)). |

