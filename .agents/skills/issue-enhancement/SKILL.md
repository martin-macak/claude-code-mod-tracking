---
name: issue-enhancement
description: Use when a user wants to propose, request or open a feature, enhancement or idea as a GitHub issue in this repo, or says "it would be nice if" and asks for an issue.
---

# Issue: enhancement

Help the user shape a raw idea into an enhancement issue. Explore the idea with them first: who needs it, why, the use cases, the options. Then file it.

**Core rule:** the issue states a problem and a reason before it states a solution. If the user cannot say why, the idea is not ready; say so.

This skill is the brainstorm for this flow. Do not invoke `superpowers:brainstorming`: that skill ends in a design spec, this one ends in an issue.

## Rules for the whole flow

- Ask every question with `AskUserQuestion`. 1–4 questions per call, one topic per call. Preferred option first, with ` (Recommended)`. "Other" is always there for free text.
- Make options concrete guesses from the repo and the idea, so the user reacts instead of writing from scratch.
- Wait for each answer. Reflect it back in one line before the next topic.
- Never run `gh issue create` before the user picks "Create" in step 8.

## Steps

1. **Context.** Read what exists before you ask: `README.md`, `plugins/*/README.md`, related code (ProjectAtlas `atlas_search`, or grep). Run `gh issue list --state all --search "<key words>"`. If a duplicate exists, ask: comment on it, file anyway, or stop. Link related (not duplicate) issues in the body.
2. **Why.** Ask who needs this and what fails or hurts today. In a second call, ask what happens if nobody builds it. Push until there is one concrete reason. Probe vague answers ("it would be nicer") once more.
3. **Use cases.** Draft 2–4 concrete use cases ("As a … I … so that …") from the answers. Ask with `multiSelect: true` which to keep; the user fixes or adds one through "Other". Ask for one edge case (empty data, many items, narrow terminal, failure of an external tool).
4. **Options.** Offer 2–3 ways to solve it, with trade-offs, and recommend one. Include "do nothing" or "existing workaround" when it is real. The rejected options become "Alternatives considered".
5. **Scope.** Ask what is out of scope. Check the kept use cases against it; on a conflict, ask which wins and move the loser to a follow-up issue. Propose a split if the idea holds more than one feature.
6. **Acceptance criteria.** Draft checkable criteria from the use cases. Ask the user to confirm them.
7. **Place it.** The issue joins the delivery plan: `AGENTS.md`, "Planning and delivery". Read the Area options and the Order of the open items first (`project-sync` skill, "Place a new issue"). Ask in one `AskUserQuestion` call:
   - Milestone: the open milestone that fits, or none.
   - Blockers: open issues that must close first (seen in step 1 or 5), or none.
   - Area: an Area option of the project.
   - Order: a number among the open items. Propose one from the value of the idea. The owner has the last word.
8. **Preview and create.** Write the body to the scratchpad dir. Show the title, the full body and the placement (milestone, blockers, Area, Order). Ask: "Create", "Edit", "Cancel". On "Create":

   ```bash
   gh issue create --title "<title>" --label enhancement --body-file <scratchpad>/enhancement-body.md \
     [--milestone "<milestone>"] [--blocked-by <n>[,<n>]]
   node .agents/skills/project-sync/scripts/sync.mjs add <number from the URL> --order <order> --area <area> --release <release> --apply
   ```

   Pass `--label enhancement` by hand; `gh` does not apply the issue form. Pass `--milestone` and `--blocked-by` only when the user chose them. Get `Release` by the rule in `AGENTS.md`, "Planning and delivery", "Fields". When `add` cannot write (exit 3), say so and give the user the command to run later. When `add` exits 1 with "refusing to write", the read of the project was incomplete and nothing was written. Wait a minute and run the same `add` again: it is safe to repeat. If it refuses again, give the user the command to run later. Give the user the issue URL as a link.

Go back to an earlier step when an answer changes it. Stop if the user drops the idea.

## Title

Sentence case. State the outcome in imperative mood. No type prefix, no trailing period, at most 72 characters. Example: `Show Jira assignee in the /track pane`.

## Body

Keep the headings of `.github/ISSUE_TEMPLATE/feature_request.yml`, in this order. Use cases and the edge case have no form field, so they go under Problem:

```markdown
### Problem
Who needs this. What fails today. Why it matters.
#### Use cases
- As a ..., I ..., so that ...
- Edge case: ...
### Proposal
What should happen. Out of scope: ...
### Acceptance criteria
- [ ] ...
### Alternatives considered
- Option: why not chosen.
```

Write in short, active sentences. Use `#N` for other issues and PRs.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Jumping to UI details (column, tooltip) first | Steps 2–3 come first: why and use cases. |
| One batch of questions, then done | One topic per call, reflect, then move on. |
| "Problem" restates the proposal | Problem = pain without the solution in it. |
| Alternatives left empty | Use the options from step 4. |
| Issue created without the `enhancement` label | Pass `--label enhancement`. |
| A blocker named only in the body | Pass `--blocked-by`. The native link is the source of the plan. |
| Issue left out of the project | Step 8 ends with `project-sync add`. |
| Questions in plain text | Use `AskUserQuestion`. |
