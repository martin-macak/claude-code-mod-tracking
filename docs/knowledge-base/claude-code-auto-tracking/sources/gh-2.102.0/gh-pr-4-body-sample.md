## Summary

- **Linters and hooks.** `.pre-commit-config.yaml` adds hygiene hooks, `markdownlint-cli2`, Biome (format, lint, import order on `plugins/`), `shellcheck`, `actionlint` and `tsc`. Two `commit-msg` hoo
- **CI.** The new `lint` workflow runs the hooks. It also checks the PR title (Conventional Commits, sentence case) and the branch name (`<type>/<summary>`).
- **Clean tree.** Biome formats the mod once. This is most of the diff. It is mechanical. Lint fixes: two unused helpers, unused `$` parameters, optional chains, `import type`. Six Markdown findings i
- **Rules.** `AGENTS.md` defines one type list for branches, commits and PR titles, plus rules for issues, PRs and merges. The three enforcers (hook, CI, docs) use the same rule.
- **Templates.** Issue forms (Bug report, Feature request, Task) set the labels. Blank issues are off. A PR template has Summary, Linked issue and Test plan. A new `chore` label backs the Task form.
- **README.** The root `README.md` was empty. It now covers purpose, layout, quick start, lint and CI.

Disabled rules, each with a reason in its config: `MD013` (no prose wrap), `MD060` (compact tables), Biome `noNonNullAssertion` (`noUncheckedIndexedAccess` makes `m[1]!` idiomatic), `noControlCharacte

## Repo settings changed

Applied with `gh api` after you approved them, so `main` keeps the convention:

- Squash commit title: `PR_TITLE`, message: `PR_BODY`. Before, a one-commit PR used the commit title, which is why #2 and #3 lost their `feat:`/`fix:` prefix on `main`.
- Merge commits: off. Branches: deleted on merge.

## Linked issue

None.

## Test plan

- [x] `pre-commit run --all-files`: all hooks pass.
- [x] `make test`: validate passes, `tsc` is clean, 231 tests pass.
- [x] `commit-msg` hooks: both commits pass. `chore: add x`, `Add x` and a subject with a trailing period fail.
- [x] CI: `test`, `lint / pre-commit` and `lint / pr-conventions` pass on this PR.

Generated with Claude Code

