# claude-code-mod-tracking

Claude Code mods (function-hooks plugins) and the research behind them.

The first mod is [`artifact-tracking`](plugins/artifact-tracking/README.md). It tracks the GitHub issues and PRs, Jira work items and web links that a session mentions. It shows them in a `/track` pane and in a band above the prompt.

> Mods are in early access. The API changes between Claude Code releases. This repo pins Claude Code 2.1.295 and newer.

## Layout

| Path | Content |
| --- | --- |
| [`plugins/`](plugins/) | The mods. One folder per mod. |
| [`docs/knowledge-base/`](docs/knowledge-base/AGENTS.md) | Research notes, one folder per problem. Start with `claude-code-mods/`. |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Design specs. |
| [`AGENTS.md`](AGENTS.md) | Rules for agents and contributors: lint, branches, commits, PRs, issues. |
| [`Makefile`](Makefile) | Build, test, lint and install targets. |

## Quick start

Requirements: `claude` 2.1.295 or newer, `mise` with `node@24`, and `pre-commit`. `gh` and `acli` are optional.

```bash
make init      # check the tools
make hooks     # install the git hooks (once per clone)
make test      # validate, type-check and test the mod
make install   # load the mod in every session
```

Run `make help` for every target. To try the mod once, without install:

```bash
claude --plugin-dir plugins/artifact-tracking
```

## Lint

`make lint` runs all hooks in [`.pre-commit-config.yaml`](.pre-commit-config.yaml) on all files.

| Hook | Checks |
| --- | --- |
| `pre-commit-hooks` | Whitespace, end of file, line endings, YAML, JSON, merge markers, symlinks, large files, private keys, no commit to `main`. |
| `markdownlint-cli2` | Markdown. Config: [`.markdownlint-cli2.jsonc`](.markdownlint-cli2.jsonc). |
| `biome-check` | Format, lint and import order of `plugins/`. Config: [`biome.json`](biome.json). |
| `shellcheck` | Shell scripts. |
| `actionlint` | GitHub Actions workflows. |
| `typecheck` | `tsc` on the mod (`make typecheck`). |
| `conventional-pre-commit`, `commit-subject-case` | Commit messages. See [`AGENTS.md`](AGENTS.md#commits). |

## CI

| Workflow | Runs |
| --- | --- |
| [`test`](.github/workflows/test.yml) | `make test` on every PR and push to `main`. |
| [`lint`](.github/workflows/lint.yml) | The pre-commit hooks, the PR title check and the branch name check. |

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. In short: branch `<type>/<summary>`, Conventional Commits with a sentence-case subject, one PR per change with `Closes #N`, squash merge.
