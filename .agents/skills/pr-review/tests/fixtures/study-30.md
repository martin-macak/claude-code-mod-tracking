## Design study: priority on tracked items, with auto priority per item class

**Overall: Go** (weighted mean 76/100). Every `Must` item has a tested path. The pane focus spikes ran in a real Claude Code TUI. The weak end is the auto rules (R7, R8) and the key handling (R3): they are exact but cover a named subset of cases.
Not tested: R7 and R8 did not run end to end (their inputs are observed, the rules are pure code). R11 and R12 are design only.

Evidence: [evidence comment](https://github.com/martin-macak/claude-code-mod-tracking/issues/30#issuecomment-6155096552). Probe harness: [probe comment](https://github.com/martin-macak/claude-code-mod-tracking/issues/30#issuecomment-6155096902).

<details><summary>How the study was run</summary>

- Claude Code 2.1.296. Repo at `main` 50d257f. `make test`: 535 pass, 0 fail.
- PoC: a probe mod with a `/pprobe` pane, run in the real TUI under a fake Messages API (no model, no login), in a private tmux socket. Four saved runs (A to D). Logs and source are in the linked comments.
- Scope: issue #30, plus "auto priority" from the user: a feature per tracked item class. GitHub PR: top priority when it is associated with the current branch. GitHub issue: inherits the priority of a tracked PR it is directly associated with.
- User decisions (asked during the study): `top` is a new level above `high`, set by auto rules only. A manual level wins over the auto level. "Directly associated" means GitHub closing references only. Keys are digits.
- Reviewers: the `advisor` model (step 6 and step 10). Its step-6 findings changed R3 to `Partial`, required named passing tests for every Evidence 4, moved the closing data onto the PR record, and fixed the element-key parsing.
- Decision model: TypeSafe Jev (`jev-1.13.0`). One `jev_ask` per item for Ease, Safety and the verdict. One `jev_check` per claim in the final review. `jev_triage` was not used in step 2: the files were found by grep on known paths. Judgments are in the evidence comment.
- The output goes to this issue only. Nothing was committed. No PR.

</details>

### 1. Score

| Rank | Item | Priority | Verdict | Evidence | Ease | Safety | Score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | R8 Auto: issue closed by a PR inherits its level | Should | Partial | 4 | 3 | 3 | 53 |
| 2 | R7 Auto: PR on current branch is top | Should | Partial | 4 | 4 | 3 | 57 |
| 3 | R12 Manual high exempt from the cap | Could | Partial | 4 | 4 | 3 | 57 |
| 4 | R3 Keys 1/2/3/0 on the focused row | Must | Partial | 5 | 3 | 3 | 60 |
| 5 | R9 Auto rules per item class | Should | Feasible | 4 | 3 | 5 | 78 |
| 6 | R2 Sort sections by effective priority | Must | Feasible | 4 | 4 | 4 | 80 |
| 7 | R5 Merge keeps the highest manual level | Must | Feasible | 4 | 4 | 4 | 80 |
| 8 | R6 Persistence (refresh, re-open, /clear, store) | Must | Feasible | 4 | 4 | 4 | 80 |
| 9 | R11 /track prio command | Could | Feasible | 4 | 4 | 4 | 80 |
| 10 | R1 priority field on the record | Must | Feasible | 4 | 4 | 5 | 84 |
| 11 | R10 README docs | Should | Feasible | 4 | 5 | 5 | 90 |
| 12 | R4 Marker glyph per level | Must | Feasible | 5 | 4 | 5 | 94 |

**Overall: Go** (mean >= 75). Weighted mean: 76/100. Items are ranked weakest first. No evidence-rule notes.

Weakest three:

- **R8**: only PRs that discovery found carry closing references. A PR you tracked from the conversation but that discovery never found does not pass its level on.
- **R7**: needs auto discovery (a git repo, `gh` installed and logged in). Detached HEAD gives no current branch. A fork PR with the same head branch name can match.
- **R12**: more than 500 `high` items would block the cap. The exempt set needs its own bound.

### 2. Feasibility per item

| Item | Priority | Verdict | Mechanism | Caveat | Evidence |
| --- | --- | --- | --- | --- | --- |
| R1 `priority` field | Must | Feasible | Optional `priority?: 'high' \| 'normal' \| 'low'` on `ItemRecordBase` (manual only). `TrackedItem` copies it in the constructor and in `baseRecord()`, as it does `refreshedAt`. Absent means "no manual choice". | None | `[primary source]` `types/index.d.ts`. Passing test `model.test.ts` "GitHubItem does not mutate its input record and toRecord omits undefined fields". |
| R2 Sort | Must | Feasible | A stable sort of the top-level records by effective rank (`top` > `high` > `normal` > `low`), then the old comparator (`firstSeen`, then `number`). In `buildPane` (Jira, GitHub, Web links) and `prsSection` (Pull requests). Jira children come from `nodeRows` under their parent, so they move with it. | Worktrees, Agents and Processes rows are not items and get no priority. The issue's "Artifacts" section does not exist. See section 8. | Passing tests `view.test.ts` "rows sort by firstSeen inside a section", `auto-view.test.ts` "Pull requests: a discovered PR shows only here". |
| R3 Keys | Must | Partial | A plain marker Button first in each item row. A `ui.focus` hook maps the focused element to its item. Footer Buttons with hotkeys `1` `2` `3` `0` change that item. The marker key holds the row index and the level. The render hook calls `$.ui.focus` when the focused row moved. | `+` and `-` are refused by the engine. Up and Down move the focus only while the pane fits its window. In a taller pane they scroll, and Tab walks. `[inference]` Rows with a fold and an `x` Button take 2 to 3 presses per row (probe rows had one Button). `[primary source]` The ring stops only on a `Button`, `Input` or `Select` (d.ts `UiFocusArgs.key`), so the key cell's `Link` is no stop. | `[observed]` runs A to D (S1 to S6). |
| R4 Marker | Must | Feasible | The marker Button label: `★` top, `▲` high, `▽` low, a blank for normal. A level from an auto rule draws dim. `/track` text prefixes the same glyph. | None | `[observed]` the probe pane drew `▲` and `·` Buttons and the ring stopped on them (runs A, B). `▽`, `★` and the dim tone were not drawn. |
| R5 Merge | Must | Feasible | `fold()` in `model/registry.ts` is the only place where two records of one key become one. Today it clones the record with the newer `refreshedAt`. Add: the higher manual level of the two wins, as `via` is unioned there. | Without this change, `/clear` carry-over and bare `#N` resolution can drop a mark. | Passing tests `registry.test.ts` "fold and unionRecords merge via", "resolveBareRefs: folds into an existing target", "unionRecords: folds sightings and takes status from the newer refresh". |
| R6 Persistence | Must | Feasible | The field rides in `ItemRecord`. `writeStore` saves it with the session copy. `/clear` carries it with `unionRecords`. A refresh keeps it: `mergeResults` copies only status fields from the fresh record. The `x` button and `/track clear` delete the record, so a re-tracked item starts with no mark. | A new session does not restore items, so no mark carries over (issue open question 3). | Passing tests `register.test.tsx` "/clear carry-over, store path", "session.start restores the stored copy of a session it knows", `registry.test.ts` "mergeResults keeps via, headRefName and baseRefName of the stored record". |
| R7 Auto PR | Should | Partial | Current branch = `branch` of the `ag:master` row in `auto.snapshot.agents`. It comes from `$.session.cwd()` and `git worktree list`, so it follows `EnterWorktree`. Rule: `type` is `pr`, `state` is `open`, the repo is the session repo, `headRefName` equals the current branch. | See "Weakest three". A PR on a branch that is not polled (over `maxBranches`) has no `headRefName`. | `[observed]` auto-tracking KB F9 and F13 (master row from the cwd). `[observed]` gh GraphQL reply with `headRefName`. Passing tests `agents.test.ts` (master row branch), `pr-discovery.test.ts` "parseDiscovery". |
| R8 Auto issue | Should | Partial | Discovery already reads `closingIssuesReferences` (`DiscoveredPr.closing`). Store `closes?: string[]` (issue keys) on the PR record in `discoveryFields`, and compare it in `isCurrent`. The view builds `issueKey → PRs` once per render. An issue takes the highest level of its closing PRs. | See "Weakest three". The refresh query in `gh-tool.ts` has no closing references. | `[observed]` `gh-graphql-base-filter-and-closing-issues.json`. Passing test `pr-discovery.test.ts` "parseDiscovery: maps fields, checks, state and closing refs". `[primary source]` `gh-tool.ts` `buildQuery`. |
| R9 Per class | Should | Feasible | A pure module `model/priority.ts`: a rule table keyed by item class (`github-pr`, `github-issue`, `jira`, `web`). Jira and Web have no rule yet. The view calls `effectiveLevels(records, ctx)`. | A table, not a `TrackedItem` method: the view holds records and `ToolStatus`, and `hydrate()` needs the tools. Same shape as `STATUS_FIELDS` in `registry.ts`. | `[primary source]` `view.ts`, `auto-view.ts` (pure over records), `registry.ts` `hydrate`. 535 tests pass. |
| R10 Docs | Should | Feasible | README "Commands" and the pane section list the keys, the glyphs and the auto rules. | None | `[primary source]` README. |
| R11 `/track prio` | Could | Feasible | A new branch in the `/track` handler, next to `refresh` and `clear`: `/track prio <ref> <high\|normal\|low\|auto>`. The ref goes through `extractRefs` and `keyOf`. | Design only. | Passing test `register.test.tsx` "/track clear empties the list; an unknown argument prints the usage". |
| R12 Cap pin | Could | Partial | Pass the keys of manual `high` records in the `keep` set of `enforceCap`. | Bound the set (for example the 100 newest `high` items), or the cap can fail. Design only. | Passing tests `registry.test.ts` "mergeRefs: cap drops the smallest lastSeen", "cap: 501 mentioned plus 100 auto-only items evict one mentioned item". |

