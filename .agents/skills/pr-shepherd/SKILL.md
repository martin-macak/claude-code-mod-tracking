---
name: pr-shepherd
description: Use when asked to shepherd a pull request in this repo, fix a PR, address or answer review comments, fix failing PR checks, resolve PR conflicts, or get a PR ready for merge.
argument-hint: <PR number or URL>
model: sonnet
---

# PR shepherd

Take one open pull request to merge-ready. The human merges. You never merge.

This skill is the single source of the procedure. Three entry points run it, with the same result:

| Entry point | Runtime | Mode |
| --- | --- | --- |
| `/pr-shepherd <n>` | Claude Code, on your machine | interactive |
| `pr-shepherd` agent, `.claude/agents/pr-shepherd.md` | Claude Code subagent | autonomous |
| `pr-shepherd` agent, `.github/agents/pr-shepherd.agent.md` | Copilot cloud agent | autonomous |

Read `AGENTS.md` first. Its rules apply to you, above all "Before you commit or push" and "Pull requests".

## Inputs

The prompt or the skill argument names the PR: a number, a URL or "this PR". When you run on a PR comment, the PR is the one you run on. Work on the PR's head branch. Never open a second PR.

A prompt can limit the run, for example "triage only" or "change nothing". Then do steps 1 and 2, report the triage table, and stop.

## Modes

- **Autonomous**: you run as the Copilot agent or as a subagent, or the prompt says to run without asking. Do not wait. Leave **needs human** rows open with the question in the thread, and list them in the report.
- **Interactive**: every other run. Before the first push, reply, resolve or PR body edit, show the triage table and wait for the human to agree. Ask each **needs human** question there, not only in the thread.

## Workspace

- On Copilot, you already run on the head branch. Work there.
- On your machine, stay in the current directory when it is a checkout of the head branch. Otherwise check out the PR in a worktree, not in the main checkout: `git worktree add ../<repo>.worktrees/<head-branch> <head-branch>`. Run `make hooks` once when the clone has no hooks yet.

## Tools

Use `gh` when you have it. On Copilot, use the GitHub MCP tools: `github/*` reads, `github-rw/*` writes (replies, resolves, PR body).

| Task | `gh` |
| --- | --- |
| PR state | `gh pr view <n> --json title,body,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,commits,files,reviews,comments` |
| Checks | `gh pr checks <n>` |
| Failing job log | `gh run view <run-id> --log-failed` |
| Review threads with IDs | `gh api graphql` on `repository.pullRequest.reviewThreads`, fields `id`, `isResolved`, `isOutdated`, `path`, `line`, `comments { nodes { databaseId author { login } body } }` |
| Inline comments | `gh api repos/{owner}/{repo}/pulls/<n>/comments` |
| Reply in a thread | `gh api repos/{owner}/{repo}/pulls/<n>/comments/<comment-id>/replies -f body=...` |
| Resolve a thread | `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>` |
| Edit the PR body | `gh pr edit <n> --body-file <file>` |
| Mark ready | `gh pr ready <n>` |

## Procedure

Follow the steps in order. Keep a todo list with one item per step.

### 1. Collect the full state

Read everything before you change anything.

- The PR: title, body, base, head, draft state, mergeable state, commits, changed files.
- The linked issue (`Closes #N`, `Fixes #N`, `Refs #N`): its full body and its comments. These are the original requirements.
- Every review thread: resolved or not, outdated or not, the file and line, every reply. You need the thread IDs to resolve threads.
- Every review body and every PR comment, from people and from bots (Copilot, Codex, Claude).
- Every check run on the head commit. For each red check, read the failing job log, not just the check name.
- Is the branch behind `main`? Does it have conflicts?

### 2. Triage

Build one table with a row per item: each unresolved thread, each review or comment that asks for a change, each red check, each conflict, each gap in the PR body.

| # | Source | Item | Verdict | Action |
| --- | --- | --- | --- | --- |

Verdicts:

- **fix**: the item is right. You change the code, the tests or the docs.
- **already fixed**: a later commit fixed it. Name the commit.
- **won't fix**: the item is wrong or out of scope. Give the evidence: code, test output, a rule in `AGENTS.md`. Bot findings are often false positives. Check each one against the code before you act.
- **needs human**: a product decision, an unclear request, or a conflict between reviewers. Ask one precise question.
- **follow-up**: valid but outside the PR. Propose an issue. Create it only with the `issue-bug` or `issue-enhancement` skill rules.

In interactive mode, show the table now and wait for agreement.

### 3. Rebase and resolve conflicts

- When the branch is behind `main` or has conflicts: `git fetch origin main`, then `git rebase origin/main`. Never merge `main` into the branch. A stacked PR is different: see "Stacked PRs" below.
- Resolve each conflict so that both sides keep their intent. Read the commit on `main` that caused it. When the intents clash, mark the item **needs human** and stop the rebase (`git rebase --abort`).
- Squash fixup commits so the branch keeps the fewest commits with logical steps.
- A rebase rewrites history. Push it with `git push --force-with-lease`, never `--force`. When your environment cannot force-push, do not merge `main` in. Report that a rebase is needed, and do the other steps.

#### Stacked PRs

A stack is a chain of PRs. Each PR is based on the branch of the PR below it. GitHub native stacks and the `gh stack` extension manage it. Some rules for a plain PR break a stack.

- Detect a stack with `gh stack view --json`. The PR is stacked when its number is in `branches[].pr.number`. Always pass `--json` (or `--short`): bare `gh stack view` is an interactive view and can stall an agent. Work on the branch of the layer you fix (`gh stack checkout <branch>`).
- Rebase with `gh stack rebase`. After you change a lower layer, run `gh stack rebase --upstack` from that layer. Never run `git rebase origin/main` on a mid-stack layer: the layers above lose their base.
- Push with `gh stack push`. It pushes every layer with `--force-with-lease`. Do not push a single layer with `git push`.
- Run `make verify` on every layer before the push. Start with `gh stack bottom`, run `make verify`, then `gh stack up` and run it again, up to the top. Each PR must pass on its own.
- `gh stack submit` writes the commit subject as the PR title. It writes the commit body and an HTML footer as the PR body. The body has no `## Requirements` section, so `pr-body` fails. After `gh stack submit` or `gh stack push`, check each PR body against the template and edit it (step 8).
- Never run `gh pr merge` on a stacked PR. It fails with `This pull request is part of a stack and must be merged using the asynchronous merge REST API`. The merge command is `gh stack merge --squash` (add `--yes` without a TTY). It lands the PR and every PR below it. It waits for the human: you never run it.
- When `main` moves, the strict check policy blocks the whole stack. `gh stack merge` then fails with `Required status check ... is expected.` GitHub shows a check as `expected` when no status arrived for it. The text alone does not prove the stack is behind `main`: a check that never ran on the head gives it too. Find the cause first. Run `git fetch origin main`, then `git merge-base --is-ancestor origin/main <bottom-branch>`. A non-zero exit means the stack is behind. Run `gh pr checks <n>` on every layer. Each required check needs a run on the head of its layer.
  - Behind `main`: run `gh stack rebase` and `gh stack push`. Then wait for CI on every layer.
  - A check has no run on the head: find out why (the run can be cancelled; `gh run rerun <id>` restarts it). Do not rebase for this cause.

### 4. Fix

- One logical change per commit. Conventional Commits, rules in `AGENTS.md`. Add `Refs #N` for the linked issue.
- On a stack, fix a finding on the layer that owns the code. Check out that layer, commit there, then run `gh stack rebase --upstack`.
- For a bug: write a test that fails first, then fix it (`test-driven-development` skill).
- Fix a red check at its cause. Never weaken a test, an assertion or a lint rule to make a check green. When a test expectation must change, say why in the reply.
- Never bypass hooks. The verify gate (`scripts/hooks/verify-gate.sh`) blocks the push until `make verify` passes. Run `make verify` yourself first.

### 5. Prove the original requirements

- List each requirement and acceptance criterion from the linked issue, plus each change a reviewer asked for and you accepted.
- For each one, name the test that proves it. A requirement with no test gets a test now.
- Run `make verify`. Read the output. All hooks pass, all tests pass, with no fixer changes left unstaged.
- When `plugins/` or `e2e/` changed, run `make e2e-safe` when you have a Claude login and tmux. When you cannot, say so in the Test plan. A change to the artifact tracker also needs `make e2e`: `AGENTS.md`, "Lint and hooks" says when.

### 6. Push

Push only after step 5 is green. On a stack, run `make verify` on every layer first, then push with `gh stack push`. Then wait for the CI checks on the new head commit. When a check fails, go back to step 4. After three failed rounds, stop and report what blocks you.

### 7. Reply and resolve

For each row of the triage table, answer where the item came from:

- **fix** and **already fixed**: reply in the thread with `Fixed in <short-sha>: <one sentence>`. Then resolve the thread.
- **won't fix**: reply with the reason and the evidence. Leave the thread open. The reviewer resolves it.
- **needs human**: reply with the question. Leave the thread open.
- **follow-up**: reply with the issue link or the proposal. Leave the thread open.

Resolve only threads you answered. Never resolve a thread to hide it. When you lack write access to threads, post the full triage table as one PR comment instead, and say that the threads still need a reply.

### 8. Update the PR body

Rewrite the body with `.github/pull_request_template.md`. The `pr-body` check (`scripts/ci/check-pr-body.sh`) enforces it. On a stack, rewrite the body of every layer you pushed, not only one.

- **Summary**: what the PR does now, after your fixes.
- **Linked issue**: `Closes #N`, or `None` when no issue exists. Keep every link line that is there. A stack layer keeps the `Closes` line of its sub-issue and the `Refs` line of the parent, and the top layer keeps the `Closes` line of the parent too (`AGENTS.md`, "Planning and delivery", "Stack layers").
- **Requirements**: one ticked line per requirement from step 5, with its test.
- **Test plan**: tick only what ran and passed. Not applicable: tick it and write `N/A: <reason>`.
- Remove claims that the code does not back.

### 9. Finish

- Ready means: all checks green, no **fix** row left, the PR body passes `pr-body`, the branch is up to date with `main`.
- When the PR is ready and still a draft, mark it ready for review. When rows are **needs human** or **won't fix**, leave the draft state alone and say so.
- When the PR is ready and it closes its issue (`Closes` or `Fixes`), run `node .agents/skills/project-sync/scripts/sync.mjs status <issue number> "In review"`. For `Refs` (partial work), leave the issue alone. For a stack layer, the issue it closes is the sub-issue of that layer: move it, never the parent (`AGENTS.md`, "Planning and delivery", "Stack layers"). When the command exits 3 (no `project` scope) or exits 1 with "is not in the project", do not retry and do not run `add`, which needs an `Order`. Name the Status move in the report instead. When it exits 1 with "refusing to write", the read of the project was incomplete and nothing was written. Wait a minute and run the same command once more. If it refuses again, name the Status move in the report.
- End with a short report: the triage table with the final verdicts, the commits you pushed, the check results, and what the human must still do.

## Hard rules

- Never merge the PR (`gh pr merge`, `gh stack merge`). Never push to `main`. Never push a tag.
- Never use `--force`, `--no-verify`, `SKIP=` or `core.hooksPath`.
- Never claim a check passes without fresh output (`verification-before-completion` skill).
- Never delete or weaken a test to make it pass.
- Never set `Done` or `Order` in the GitHub Project.
- Leave the PR's scope alone. New ideas become **follow-up** rows.
