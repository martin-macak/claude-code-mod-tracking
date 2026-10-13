# Copilot instructions

Read `AGENTS.md` first. It holds every rule for this repo.

The rules you MUST follow on every task:

- Before every push, run `make verify` and see it pass. It lints with auto-fix and runs the tests. A hook gate blocks `report_progress` until it passes.
- When a fixer changes files, review the diff, stage it, and run `make verify` again.
- Before you finish, re-read the issue and the review comments. Prove each requirement with a test. List them, ticked, in the PR's "Requirements" section.
- Never claim "done" or "passing" without fresh output. Never bypass the hooks.
