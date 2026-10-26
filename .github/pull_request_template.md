<!-- markdownlint-disable-file MD041 -->
<!--
Title: <type>(<optional scope>): <Subject>. Example: "feat(track): Add a Jira column".
Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
The title becomes the squash commit on main. Rules: AGENTS.md.
The pr-body check fails on a missing issue link, an empty Requirements section
or any unticked box.
A stack layer PR says "Closes #<sub-issue>" and "Refs #<parent>". The top layer also closes the parent.
Rules: AGENTS.md, "Planning and delivery".
-->

## Summary

<!-- What changes and why. One idea per bullet. -->

-

## Linked issue

<!-- "Closes #N" closes the issue on merge. Use "Refs #N" for partial work. For trivial, chore and ci PRs, "None" is allowed. -->

Closes #

## Requirements

<!--
Re-read the issue. One item per requirement or acceptance criterion.
Name the test or the check that proves it. Tick it only after you saw it pass.
No issue: list what this PR promises.
Example: - [x] Band shows "Processes n" — tests/view.test.ts, "band lists processes"
-->

- [ ]

## Test plan

<!-- Tick what ran and passed. Not applicable: tick it and write "N/A: <reason>".
After a change to the artifact tracker, run `make e2e` too: AGENTS.md, "Lint and hooks". -->

- [ ] `make verify` (lint with auto-fix, test, e2e-unit)
- [ ] `make e2e-safe` after a change in `plugins/` or `e2e/`
