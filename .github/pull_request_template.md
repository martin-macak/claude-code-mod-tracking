<!-- markdownlint-disable-file MD041 -->
<!--
Title: <type>(<optional scope>): <Subject>. Example: "feat(track): Add a Jira column".
Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
The title becomes the squash commit on main. Rules: AGENTS.md.
The pr-body check fails on a missing issue link, an empty Requirements section
or any unticked box.
-->

## Summary

<!-- What changes and why. One idea per bullet. -->

-

## Linked issue

<!-- "Closes #N" closes the issue on merge. Use "Refs #N" for partial work. Write "None" when no issue exists. -->

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

<!-- Tick what ran and passed. Not applicable: tick it and write "N/A: <reason>". -->

- [ ] `make verify` (lint with auto-fix, test, e2e-unit)
- [ ] `make e2e` after a change in `plugins/` or `e2e/`
