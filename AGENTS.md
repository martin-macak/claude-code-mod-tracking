# claude-code-mod-tracking

Workspace to build a Claude Code mod (function-hooks plugin).

- Docs live in `docs/`. Read `docs/AGENTS.md` first.
- Knowledge base on mods: `docs/knowledge-base/claude-code-mods/`.
- ProjectAtlas indexes this repo (`.projectatlas/`). Navigate with the `atlas_*` MCP tools or the `projectatlas` CLI before reading files. Run `projectatlas scan` after large changes.

## Lint and hooks

- Run `make hooks` once per clone. It installs the `pre-commit` and `commit-msg` git hooks from `.pre-commit-config.yaml`.
- Run `make lint` before you push. It runs every hook on all files. CI runs the same hooks (`.github/workflows/lint.yml`).
- Run `make test` after a change in `plugins/`.
- Never skip hooks (`--no-verify`). Fix the cause.
- Fix lint findings in the code. Change a rule in `biome.json` or `.markdownlint-cli2.jsonc` only with a reason in a comment or the PR.
- The hooks skip `docs/knowledge-base/*/sources/`, `.agents/` and `.claude/`. Those files are verbatim or vendored.

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
| `ci` | GitHub Actions and other CI config. |
| `chore` | Maintenance that fits no other type: tooling, repo config. |
| `revert` | Reverts an earlier commit. |

### Branches

- Format: `<type>/<kebab-case-summary>`. Examples: `feat/jira-column`, `fix/render-guards`, `chore/rules-and-linters`.
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
- Body: use `.github/pull_request_template.md`. Sections: Summary, Linked issue, Test plan.
- Link the issue with `Closes #N` (or `Fixes #N`) so the merge closes it. Use `Refs #N` for partial work.
- Keep history linear. Rebase onto `main`; never merge `main` into the branch. Squash to the fewest commits that keep logical steps. Use `git push --force-with-lease`, never `--force`.
- Open a draft PR for work in progress. Mark it ready when CI passes.
- Delete temporary files before you push: plans, scratch notes, logs. Keep design specs.
- Merge with **Squash and merge**. Use **Rebase and merge** only when the PR holds several logical commits that must stay apart. Merge commits are disabled. GitHub deletes the branch on merge.

### Issues

- Use an issue form: Bug report, Feature request or Task. Blank issues are off.
- Title: sentence case, no type prefix, no trailing period, at most 72 characters.
  - Bug: state the symptom. Example: `Pane shows a stale PR state after /track refresh`.
  - Feature or task: state the outcome in imperative mood. Example: `Show Jira assignee in the /track pane`.
- Labels carry the type: `bug`, `enhancement`, `chore`, `documentation`. The forms set them.
- Reference issues and PRs as full links in prose outside GitHub, `#N` inside GitHub.
