# claude-code-mod-tracking

Workspace to build a Claude Code mod (function-hooks plugin).

- Docs live in `docs/`. Read `docs/AGENTS.md` first.
- Knowledge base on mods: `docs/knowledge-base/claude-code-mods/`.
- ProjectAtlas indexes this repo (`.projectatlas/`). Navigate with the `atlas_*` MCP tools or the `projectatlas` CLI before reading files. Run `projectatlas scan` after large changes.

## Before you commit or push

These rules are mandatory for every agent (Claude, Copilot, Codex) and every person. "MUST" means no exceptions.

1. You MUST run `make hooks` once per clone. Copilot's setup steps (`.github/workflows/copilot-setup-steps.yml`) do it for Copilot.
2. You MUST run `make verify` and see it pass before every push. It lints with auto-fix, then runs `make test` and `make e2e-unit`. Stage new files first: the hooks skip untracked files.
3. A fixer (Biome, markdownlint, whitespace) rewrites files and fails the run. Review the diff, stage it, run `make verify` again.
4. You MUST check the original requirements before you push and again before you mark a PR ready:
   - Re-read the linked issue and every review comment.
   - List each requirement and acceptance criterion.
   - Name the test that proves each one. No test: write it first (`test-driven-development` skill). It must fail without your change.
   - Copy the list into the PR's "Requirements" section. Tick an item only after you saw its test pass.
5. You MUST NOT claim "done", "fixed" or "passing" without fresh output that proves it (`verification-before-completion` skill).
6. Never bypass the gate: no `--no-verify`, no `SKIP=`, no `core.hooksPath`. Fix the cause.

Enforcement, so a skipped step fails loudly:

- Git hooks: `pre-commit` lints and fixes, `commit-msg` checks the message, `pre-push` runs the tests.
- Agent hooks: `scripts/hooks/verify-gate.sh` denies `git push`, Copilot's `report_progress` and hook bypasses until `make verify` passes. Copilot calls it from `.github/hooks/verify.json`. It also blocks the end of a Copilot session with red checks or unpushed changes. Claude Code calls it from `.claude/settings.json`.
- CI: `lint.yml` (`pre-commit`), `pr.yml` (`pr-body`, `pr-conventions`) and `test.yml` (`test`). The `main` ruleset requires them, and all review threads must be resolved.

## Lint and hooks

- Run `make hooks` once per clone. It installs the `pre-commit`, `commit-msg` and `pre-push` git hooks from `.pre-commit-config.yaml`.
- `make lint` runs every hook on all files. CI runs the same hooks (`.github/workflows/lint.yml`). `make verify` runs it too.
- Run `make test` after a change in `plugins/`.
  - A kit test checks order or causality, not wall time, and takes `test` from `plugins/artifact-tracking/tests/fixtures/kit.ts`. Rule: `docs/AGENTS.md`, "Tests". A contract in `make test-scripts` (part of `make verify` and CI) fails a test file that breaks it.
- Run `make e2e-safe` after a change in `plugins/` or `e2e/`, when you have a Claude login and tmux. It runs every scenario except `@artifacts`, with real model turns, so CI does not run it. CI runs `make e2e-unit`.
  - The `@artifacts` scenario publishes a private test page to claude.ai with your login and deletes it again. `make e2e-safe` skips it: it runs the default profile. Run `make e2e` too (`-p all`: every scenario) after a change to the artifact tracker (`plugins/artifact-tracking/trackers/artifact/`) or to the `@artifacts` scenario (`e2e/features/artifacts.feature`, `e2e/steps/artifact.steps.ts`). That scenario is the only live check of the tracker. To run it alone: `cd e2e && npx cucumber-js -p artifacts`. Plain `npx cucumber-js` skips it too. So does `npx cucumber-js features/pane.feature`. `--tags 'not @artifacts'` means the same. Add `--dry-run` to see what a command selects. A dry-run test in `make e2e-unit` pins the selection of both targets.
- Refresh the README demo GIF with the `demo-scenario` skill (`.agents/skills/demo-scenario/`, `make demo`).
- Never skip hooks (`--no-verify`). Fix the cause.
- Fix lint findings in the code. Change a rule in `biome.json` or `.markdownlint-cli2.jsonc` only with a reason in a comment or the PR.
- The hooks skip `docs/knowledge-base/*/sources/`, `.agents/` and `.claude/`. Those files are verbatim or vendored.

## Releases

- A release is a tag `artifact-tracking--v<version>`. Set the version only with `make release VERSION=x.y.z` on clean `main` equal to `origin/main`. Do not bump `plugin.json` for a release. CI stamps the tag version before validation, tests and packaging.
- Versions must be valid SemVer and newer than every existing release tag. Stable releases require no open issues in milestone `artifact-tracking <version>` when `gh` is available. Pre-releases skip this guard. CI closes the milestone after a stable publication.
- CI publishes versioned and unversioned zips. Stable releases become `latest`; pre-releases leave `latest` unchanged. The post-release smoke job checks files, fresh installs and updates from 0.1.0 with isolated CLI configs.
- Switch the marketplace to the stable archive only after `latest` carries `artifact-tracking.zip`: run `make marketplace-release` and submit its validated diff in a PR. Until that cutover, the path entry still installs `main`. The bootstrap smoke checks a temporary archive catalog.
- Never push a release tag from a feature branch. Steps: `plugins/artifact-tracking/README.md`, "Release". Background: `docs/knowledge-base/claude-code-mods/workflow/release.md`.

## Planning and delivery

The delivery order lives in three places: the public [GitHub Project 3](https://github.com/users/martin-macak/projects/3) (owner `martin-macak`), the milestone of each issue and the native "blocked by" links between issues. Read them before you pick, start or file work. This section is the only source. Other files link here.

- **Milestone.** Name it `<plugin> <version>`, for example `artifact-tracking 0.2.0`. Set it on issues only, never on PRs.
- **Blockers.** Record a dependency as a native "blocked by" link (`gh issue create --blocked-by`, `gh issue edit --add-blocked-by`), not as text. These commands need gh 2.94 or newer. A PR or a draft item cannot be a native blocker. Link the issue behind it. When the work can start earlier, add a note to "Blocked by", for example `#55 (can start when L3 merges)`.
- **Fields.**
  - `Status`: Blocked, Ready, In progress, In review or Done.
  - `Wave`: 0 when the issue has no open blocker. Else 1 plus the highest Wave of its open blockers.
  - `Order`: the owner's priority. A lower number goes first. Set it only when the owner gives the number.
  - `Release`: 0.2.0, Later or Tooling. Take it from the milestone: `artifact-tracking 0.2.0` gives `0.2.0`. With no milestone, use `Tooling` for repo tooling and `Later` for the rest.
  - `Area`: core, ux, trackers, tooling or release.
  - `Blocked by`: the open blockers as `#a, #b`. A draft item keeps its own text.
- **Duties.**
  - Pick: run `make project-sync ARGS=next`. It prints the Ready item with the lowest Wave, then the lowest Order.
  - Start: run `make project-sync ARGS='status <n> "In progress"'` and assign yourself.
  - Stack: when an issue ships as a stack of PRs, create the sub-issues of its layers before the first `gh stack submit`. See "Stack layers".
  - File: set the milestone and the native blockers, then place the issue with `project-sync add`. The `issue-bug` and `issue-enhancement` skills do both.
  - PR ready: when the PR closes its issue, set the issue to `In review`. A PR with `Refs #N` (partial work) leaves the issue alone. A stack layer PR closes its own sub-issue, so the sub-issue moves and the parent stays. When you cannot write, or the issue has no item yet, name the move in your report. Do not add the item: that needs an `Order`. The `pr-shepherd` skill does it.
  - Merge: GitHub sets `Done`. Never set `Done` yourself.
  - Release: the milestone closes. The guard for it is [#64](https://github.com/martin-macak/claude-code-mod-tracking/issues/64).
- **Tool.** The `project-sync` skill (`.agents/skills/project-sync/`) holds the commands and the rules of the script. Do not set the Wave of an issue by hand: the skill computes it from the native links.
- **Order and positions.** `Order` also sets the manual position of each item, so a view with no sort shows the same sequence. Change `Order` to move an item. A drag in the web UI does not last.
- **Who writes.** Only a session whose `gh` token has the `project` scope (`gh auth refresh -s project`, or put a classic token with the project scope in `GH_TOKEN`; `make init` warns when it is missing). Copilot, Codex and Actions read the project when their token can (see No access), and report each change they want in the PR.
- **No access.** Pick by milestone, then by native links (no open blocker), then by the lowest issue number. It is unverified whether a token without the `project` scope can read this public project with `gh api graphql`.
- **Workflows.** The owner turns these on once, in the web UI. Keep on: the built-in workflows "Item closed" and "Pull request merged" (both set `Done`), "Auto-add to project" for `is:issue is:open` from this repo, and "Auto-add sub-issues to project" (a new sub-issue of an item joins the project). No API turns a workflow on.
- **Views.** Plan: grouped by `Wave`, sorted by `Order`. 0.2.0: sorted by `Order`. Waves: a board with `Wave` columns, sorted by `Order`. No API edits the group or the sort of a view in place. To change them, an agent with the `project` scope creates a new view by API and deletes the old one.
- **Stack layers.** An issue that ships as a stack of PRs (`gh stack`) gets one sub-issue per layer. The sub-issue is the item of its layer in the project. The layer PR is not an item.
  - Create: one issue per layer with the headings of the Task form and the label of its type, titled `#<parent> L<n>: <outcome>`, with the milestone of the parent. Add them in stack order with `gh issue edit <parent> --add-sub-issue <n>`. The workflow "Auto-add sub-issues to project" adds each one to the project. Set its Order (the Order of the layer's draft item, or a number the owner gives), Area and Release. Then delete the draft.
  - Link: each layer PR says `Closes #<sub-issue>` and `Refs #<parent>`. The top layer also says `Closes #<parent>`, because GitHub does not close a parent when its last sub-issue closes. Never link a layer PR to the parent in the Development sidebar: a lower layer can merge alone, and the link would close the parent.
  - Proof: the keywords work on every layer, also on a PR whose base is another layer. A merge of the bottom layer alone closes its sub-issue. A merge of the rest of the stack in one step closes all the other sub-issues and, through the top layer, the parent. A throwaway repo showed this on 2026-10-19.
  - Order: add no native "blocked by" links between the layers of one stack. The chain gives each layer its own Wave. The order of the sub-issues and `Order` hold the stack order. Start a layer when the layer below it has its PR.

## GitHub conventions

These rules apply to every agent and person. CI checks the PR title and the branch name. The `commit-msg` hook checks commits.

### Types

One list for branches, commits and PR titles:

| Type | Use for |
| --- | --- |
| `feat` | A new capability for the user. |
| `fix` | A bug fix. |
| `docs` | Documentation only. |
| `style` | Formatting only. No change in behavior. |
| `refactor` | A code change that neither fixes a bug nor adds a feature. |
| `perf` | A performance change. |
| `test` | Tests only. |
| `build` | Build system, `Makefile`, dependencies. |
| `trivial` | Small, low-risk maintenance with no issue required. |
| `ci` | GitHub Actions and other CI config. |
| `chore` | Maintenance that fits no other type: tooling, repo config. |
| `revert` | Reverts an earlier commit. |

### Branches

- Format: `<type>/<kebab-case-summary>`. Examples: `feat/jira-column`, `fix/render-guards`, `chore/rules-and-linters`.
- Copilot-created PR branches may use `copilot/<summary>` with the same character rules as type branches.
- Claude installer branches may use `add-claude-github-actions-<timestamp>`.
- Lowercase letters, digits, `.`, `_` and `-` only after the slash.
- Never commit to `main` directly. The `no-commit-to-branch` hook blocks it.

### Commits

- Follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/): `<type>(<optional scope>)<optional !>: <Subject>`.
- Subject: sentence case (capital first letter), imperative mood, no trailing period, at most 72 characters. Example: `fix(track): Keep short #N keys after /clear`.
- Scope: optional, lowercase kebab-case. Use the area: `track`, `kb`, `ci`, `deps`.
- Breaking change: add `!` after the type or scope, and a `BREAKING CHANGE:` footer.
- Body: why, not what. Wrap at 72 characters.
- Footers: `Refs #N` for related issues. `Closes #N` belongs in the PR body.

### Pull requests

- Title: the same format as a commit subject. The squash merge uses it as the commit on `main`, so it must be correct.
- Body: use `.github/pull_request_template.md`. Sections: Summary, Linked issue, Requirements, Test plan. The `pr-body` check fails on a missing issue link, an empty Requirements section or an unticked box.
- Shepherd a PR to ready with the `pr-shepherd` skill (`.agents/skills/pr-shepherd/`). It triages review threads, fixes them, rebases and runs the gate. The skill holds the whole procedure. Two thin agents run it: `.github/agents/pr-shepherd.agent.md` for Copilot, `.claude/agents/pr-shepherd.md` for Claude Code.
  - On your machine: `/pr-shepherd <n>` in Claude Code. It shows the triage table and waits for you before it pushes or replies.
  - Claude Code subagent: ask for the `pr-shepherd` agent.
  - Copilot: pick it in the Agents tab, or comment `@copilot Shepherd this PR. Use the pr-shepherd skill.` on any PR.
- Review a PR against its linked issue and design study with the `pr-review` skill (`.agents/skills/pr-review/`). It traces each requirement item, checks open items again for feasibility, and ranks findings by severity, each with a fix.
- Link the issue with `Closes #N` (or `Fixes #N`) so the merge closes it. Use `Refs #N` for partial work.
- Move the linked issue to `In review` when the PR is ready and closes it (`Closes`, `Fixes`). A `Refs` PR leaves the issue alone. A stack layer PR closes its own sub-issue and refs the parent. See [Planning and delivery](#planning-and-delivery), "Stack layers".
- Keep history linear. Rebase onto `main`; never merge `main` into the branch. Squash to the fewest commits that keep logical steps. Use `git push --force-with-lease`, never `--force`.
- Stacked PRs: use `gh stack` (GitHub native stacks). Name every branch. Edit each PR body to the template after `gh stack submit`. Run `make verify` on every layer before `gh stack push`. Merge with `gh stack merge --squash`, never `gh pr merge`. Link each layer as [Planning and delivery](#planning-and-delivery), "Stack layers" says.
- Open a draft PR for work in progress. Mark it ready when CI passes.
- Delete temporary files before you push: plans, scratch notes, logs. Keep design specs.
- Merge with **Squash and merge**. Use **Rebase and merge** only when the PR holds several logical commits that must stay apart. Merge commits are disabled. GitHub deletes the branch on merge.

### Issues

- Use an issue form: Bug report, Feature request or Task. Blank issues are off.
- Place every new issue in the plan: milestone, native blockers and project fields. The issue skills do it. See [Planning and delivery](#planning-and-delivery).
- Agents file issues with the `issue-bug` and `issue-enhancement` skills (`.agents/skills/`). They ask the user, run a short root cause analysis (RCA) for bugs, and show a preview before `gh issue create`.
- Agents run a feasibility study and a design draft for an issue with the `design-study` skill (`.agents/skills/design-study/`). It scores each item and the whole feature, and saves the evidence in a KB slug.
- Title: sentence case, no type prefix, no trailing period, at most 72 characters.
  - Bug: state the symptom. Example: `Pane shows a stale PR state after /track refresh`.
  - Feature or task: state the outcome in imperative mood. Example: `Show Jira assignee in the /track pane`.
- Labels carry the type: `bug`, `enhancement`, `chore`, `documentation`. The forms set them.
- Reference issues and PRs as full links in prose outside GitHub, `#N` inside GitHub.
