---
name: pr-review
description: Use when a user asks to review, check or assess a pull request in this repo against its issue, acceptance criteria or design study, or asks "is this PR done", "does the PR meet the requirements" or "review PR #N".
---

# PR review

Review a PR against its linked issue and its design study. The output is one constructive review: a status per requirement item, a second feasibility check for each open item, and findings by severity. Each finding has a fix.

**Core rule:** every finding names a place and a fix. A finding with no fix is a complaint: add the fix or drop the finding.

This skill tells you to call the `Workflow` tool. That instruction is the user's opt-in for it.

## Steps

1. **Scout.** Build the `args` for the workflow. Shape: the header comment of `workflow.js`.
   - `gh pr view <N> --json number,title,body,labels,baseRefName,baseRefOid,headRefOid,files,closingIssuesReferences`.
   - `git fetch origin <baseRefName> pull/<N>/head`. Do not check out the branch.
   - Linked issue, first that matches: `closingIssuesReferences` (source `closing`); a `Closes`, `Fixes` or `Resolves #N` in the body (`keyword`); a `Refs #N` (`refs`). The top layer of a stack closes two issues, its sub-issue and the parent (`AGENTS.md`, "Planning and delivery", "Stack layers"). Then `args.issue` is the sub-issue, and you fetch and check both: the items of the sub-issue are `R1..Rn`, the items of the parent are `P1..Pn`. None: add a `Major` finding to `args.findings` (lens `requirements`, file `PR body`, line `null`, title "No linked issue", fix "Add `Closes #N` to the PR body"). Use the PR body's Requirements section as items.
   - Fetch the linked issue in two calls, so that an old gh loses only the blocker check:
     1. `gh issue view <I> --json title,body,labels,comments,milestone`.
     2. `gh issue view <I> --json blockedBy` (gh 2.94 or newer). When it fails with `Unknown JSON field`, skip the blocker check and write "Blockers not checked: gh older than 2.94" under How the review ran.
   - `blockedBy.nodes[]` lists the native blockers, each with a `state`. When any blocker is `OPEN`, add one `Major` finding for the linked issue to `args.findings`, not one per blocker. Lens `requirements`, file `PR body`, line `null`, title "Linked issue #<I> has open blockers #<B1>, #<B2>" (list each open blocker), problem "#<I> waits for them", evidence the `blockedBy` nodes, each with its state, fix "Merge or close #<B1>, #<B2> first, or remove the link if it is wrong". Put the milestone (or none) and the blockers under How the review ran. The rules for both: `AGENTS.md`, "Planning and delivery".
   - Items. If the issue has the label `design available`: save the comment that starts with `## Design study:` (else `## Design draft`) to the scratchpad, then run `node .agents/skills/pr-review/scripts/parse-study.mjs <file>`. A `study` with items gives the items: `{ id, text, priority, study: { verdict, score, mechanism, caveat } }`. Otherwise split the issue's acceptance criteria into `R1..Rn`, `Must` each, and other "should" sentences into `Should` items. Label but no design comment: a `Minor` finding "Label `design available` but no design found". Put each parser warning under How the review ran.
   - Threads: `gh api graphql` for `reviewThreads` (`isResolved`, `path`, `line`, first comment `body`). Keep the unresolved ones.
   - Decision model: `ToolSearch` for `jev`. `args.jev` is true when the `jev_*` tools load.
2. **Fan out.** `Workflow({ scriptPath: "<repo root>/.agents/skills/pr-review/workflow.js", args })`. Pass `args` as a JSON object, not a string. Wait for the notification.
   - No Workflow tool (Copilot, Codex): read `workflow.js` and do each `agent()` step yourself, in its order, with the same prompt and output shape. Apply `gapFindings`, `merge`, `candidatePairs`, `dedup` and the verdict rule as written there. Write "Ran serially, no Workflow tool" under How the review ran.
3. **Check.** Read the result. The body must start with `## PR review`; remove any harness note left inside it. Open the cited code of every `Critical` finding and of one `Implemented` item. A wrong claim: fix it in the body, or drop the finding and say why. When `review` is `null`, fill `templates.md` yourself from the result.
4. **Preview.** Write the body to `<scratchpad>/pr-<N>-review.md`. Show the verdict, the counts, and the titles of the `Critical` and `Major` findings. Ask with `AskUserQuestion`: "Post", "Edit", "Keep local".
5. **Post.** Only on "Post": `gh pr review <N> --comment --body-file <scratchpad>/pr-<N>-review.md`. Give the user the PR link. Never pass `--approve` or `--request-changes`.

## Parts

| File | Holds |
| --- | --- |
| `workflow.js` | The fan-out: Trace, Reassess, Lenses, Verify, merge, Dedup, Synthesis. Prompts and output schemas. |
| `lenses.md` | The checklist per lens: architecture, quality, tests, requirements. |
| `severity.md` | Levels, the review verdict, the open-item table, the Jev call. |
| `templates.md` | The review body. |
| `scripts/parse-study.mjs` | Design-study comment to items with scores. |

Design and contracts: `docs/superpowers/specs/2026-10-14-pr-review-skill-design.md`.

## Decision models

If `jev_*` tools (TypeSafe Jev) are in your tool list, the workflow agents must use them. Load the `jev` skill first. These judgments repeat across many items, the case Jev is made for.

| Stage | Call |
| --- | --- |
| Trace | One `jev_check` per item: "Does this change implement this requirement correctly?" |
| Reassess | One `jev_ask` per item, as in `design-study/scoring.md`, "Jev call for one item". |
| Verify | One `jev_classify` per finding with the texts in `severity.md`. |
| Dedup | One `jev_check` per candidate pair: "Do these two findings describe the same problem?" |

A Jev answer is a proposal. `review`, `abstain` or `uncertain` means: read the evidence, then decide. Without Jev, make the same judgments and write a one-line reason each.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| A finding with no fix | Every finding gets a snippet or a suggestion block. |
| Status from the PR body's ticked boxes | Trace reads the code and the tests. A box is a claim, not evidence. |
| `Not implemented` with no second look | Every open item goes to Reassess. The first study can be wrong. |
| Checking out the PR branch | Read with `git show <head>:<path>`. The user's worktree stays as it is. |
| Posting without a yes | Preview first. Post only on "Post". |
| `--request-changes` for a `Critical` | The skill posts `COMMENT` only. The verdict line carries the weight. |
| Dropping a refuted finding silently | List it under How the review ran. |
