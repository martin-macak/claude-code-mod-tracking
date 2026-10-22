---
name: issue-bug
description: Use when a user wants to report, file or open a bug, defect or broken behavior as a GitHub issue in this repo, or says something "does not work" and asks for an issue.
---

# Issue: bug

File a bug issue with reproduction steps the user confirmed and a short root cause analysis (RCA).

**Core rule:** the user owns the facts (symptom, expected behavior, steps). You own the RCA. Write nothing in the issue that neither of you checked.

## Rules for the whole flow

- Ask every question with `AskUserQuestion`. 1–4 questions per call. Preferred option first, with ` (Recommended)`. The user can always pick "Other" for free text.
- Ask one topic per call; questions on the same topic may share a call. Wait for the answer before the next topic.
- Never run `gh issue create` before the user picks "Create" in step 8.

## Steps

1. **Symptom.** Get what happened and what the user expected. Ask for error text, not screenshots. Restate both in one sentence each and let the user confirm or fix them.
2. **Duplicates.** Run `gh issue list --state all --search "<key words>"`. A duplicate has the same symptom on the same feature. If one exists, ask: comment on it, file anyway, or stop. Link related (not duplicate) issues under Other context.
3. **Reproduction.** Draft numbered steps from the user's words. Start from a known state (for example `claude --plugin-dir plugins/artifact-tracking`). Ask the user to confirm, fix or add steps. Ask how often it happens (every time, sometimes, once). Repeat until the user confirms the steps. Do not invent steps the user did not describe; write a gap as `N. (unknown: <what is missing>)`. After two rounds, file with the gaps marked.
4. **Environment.** Run `claude --version`, `gh --version`, `uname -sr` yourself. If the bug happened on another machine or version, ask for those values instead.
5. **Short RCA.** Time-box it: about 10 tool calls in total, searches included. No changes to tracked files.
   - Find the code path for the symptom (ProjectAtlas `atlas_search`, then read the files).
   - Reproduce it when you can do so safely (a unit test, `make test`, a local command).
   - State one root cause hypothesis, the evidence (`file:line`, test output) and a confidence: confirmed, likely or unknown.
   - Stop at the cause. Do not write the fix. Name a fix direction in one line if it is obvious.
6. **RCA check by the user.** Show the hypothesis and evidence. Ask with `AskUserQuestion`:
   - "Looks right (Recommended)"
   - "Looks wrong" (then ask what they saw, and update or mark it disputed)
   - "Skip, I can't judge" (this is fine; record it as not verified)
7. **Place it.** The issue joins the delivery plan: `AGENTS.md`, "Planning and delivery". Read the Area options and the Order of the open items first (`project-sync` skill, "Place a new issue"). Ask in one `AskUserQuestion` call:
   - Milestone: the open milestone that fits, or none.
   - Blockers: open issues that must close first (seen in step 2), or none.
   - Area: an Area option of the project.
   - Order: a number among the open items. Propose one that fits the severity. The owner has the last word.
8. **Preview and create.** Write the body to the scratchpad dir. Show the title, the full body and the placement (milestone, blockers, Area, Order). Ask: "Create", "Edit", "Cancel". On "Create":

   ```bash
   gh issue create --title "<title>" --label bug --body-file <scratchpad>/bug-body.md \
     [--milestone "<milestone>"] [--blocked-by <n>[,<n>]]
   node .agents/skills/project-sync/scripts/sync.mjs add <number from the URL> --order <order> --area <area> --release <release> --apply
   ```

   Pass `--label bug` by hand; `gh` does not apply the issue form. Pass `--milestone` and `--blocked-by` only when the user chose them. Get `Release` by the rule in `AGENTS.md`, "Planning and delivery", "Fields". When `add` cannot write (exit 3), say so and give the user the command to run later. When `add` exits 1 with "refusing to write", the read of the project was incomplete and nothing was written. Wait a minute and run the same `add` again: it is safe to repeat. If it refuses again, give the user the command to run later. Give the user the issue URL as a link.

## Title

Sentence case. State the symptom. No type prefix, no trailing period, at most 72 characters. Example: `Pane shows a stale PR state after /track refresh`.

## Body

Keep the headings of `.github/ISSUE_TEMPLATE/bug_report.yml`, in this order, plus the RCA:

```markdown
### What happened
### Expected behavior
### Steps to reproduce
1. ...
Frequency: every time | sometimes | once
### Claude Code version
### Other context
OS, gh version, logs.
### Root cause analysis
Hypothesis: ...
Evidence: `path/file.ts:42`, test or command output.
Confidence: confirmed | likely | unknown
Fix direction: ... (optional)
Verified by reporter: yes | disputed | not verified
```

Write in short, active sentences. Use `#N` for other issues and PRs.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Steps written by you, never confirmed | Step 3: the user confirms every step. |
| RCA skipped as "a guess" | Do the time-boxed RCA. Mark confidence; "unknown" is a valid result. |
| RCA turns into a fix | Stop at the cause. The fix is a separate PR. |
| Asking the user for the version | Run `claude --version` yourself. |
| Issue created without the `bug` label | Pass `--label bug`. |
| A blocker named only in the body | Pass `--blocked-by`. The native link is the source of the plan. |
| Issue left out of the project | Step 8 ends with `project-sync add`. |
| Questions in plain text | Use `AskUserQuestion`. |
