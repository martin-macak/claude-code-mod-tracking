# claude-code-mod-tracking

Claude Code mods (function-hooks plugins) and the research behind them.

The first mod is [`artifact-tracking`](plugins/artifact-tracking/README.md). It tracks the GitHub issues and PRs, Jira work items and web links that a session mentions. It shows them in a `/track` pane and in a band above the prompt.

> Mods are in early access. The API changes between Claude Code releases. This repo pins Claude Code 2.1.295 and newer.

## Demo

![artifact-tracking in a Claude Code session: a prompt mentions GitHub items and a link, the band counts them, and /track shows their live state](docs/assets/demo.gif)

You mention a PR, an issue and a docs link in a normal prompt. The mod finds them, and the band above the prompt counts them at once. A second prompt adds a PR with failing checks, and the band shows `(1 ✗)`. `/track` opens a pane with the live title, state and checks of each item from `gh`, and a section for web links. Press `r` to refresh every item and `Esc` to close the pane.

What the mod does:

- Tracks GitHub issues and PRs, Jira work items and web links from your prompts, Claude's replies and tool output.
- Shows live state from `gh` and `acli`: title, open, closed or merged, failing checks, Jira status and the Epic tree.
- Shows a one-line band with counts, and a `/track` pane with refresh and dismiss.
- Tracks the worktrees, agents and PRs of the session without a mention.
- Keeps the items across `/clear`, `--resume` and `--continue`.

The GIF comes from a Gherkin scenario, [`e2e/features/tracking.feature`](e2e/features/tracking.feature), that `make demo` records. The same scenario runs as a test under `make e2e`.

## Layout

| Path | Content |
| --- | --- |
| [`plugins/`](plugins/) | The mods. One folder per mod. |
| [`e2e/`](e2e/) | Gherkin scenarios that drive a real `claude` in tmux, the demo recorder and their tests. |
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
make e2e       # run the Gherkin scenarios against a real claude (local only)
make demo      # record docs/assets/demo.gif from the @demo scenario
```

`make e2e` and `make demo` also need `tmux`, `asciinema`, `agg` and `gifsicle` (`brew install tmux asciinema agg gifsicle`). They use the Claude login and trust store of the calling shell (`CLAUDE_CONFIG_DIR`, else `~/.claude`), and they run real model turns. To refresh the GIF, follow the [`demo-scenario`](.agents/skills/demo-scenario/SKILL.md) skill.

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
| `biome-check` | Format, lint and import order of `plugins/` and `e2e/`. Config: [`biome.json`](biome.json). |
| `shellcheck` | Shell scripts. |
| `actionlint` | GitHub Actions workflows. |
| `typecheck` | `tsc` on the mod and on `e2e/` (`make typecheck`). |
| `conventional-pre-commit`, `commit-subject-case` | Commit messages. See [`AGENTS.md`](AGENTS.md#commits). |

## CI

| Workflow | Runs |
| --- | --- |
| [`test`](.github/workflows/test.yml) | `make test` and `make e2e-unit` on every PR and push to `main`. |
| [`lint`](.github/workflows/lint.yml) | The pre-commit hooks, the PR title check and the branch name check. |

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. In short: branch `<type>/<summary>`, Conventional Commits with a sentence-case subject, one PR per change with `Closes #N`, squash merge.
