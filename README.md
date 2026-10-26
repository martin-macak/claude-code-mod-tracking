<h1 align="center">claude-code-mod-tracking</h1>

```text
  __  __  ___  ___    _____ ___    _   ___ _  _____ _  _  ___
 |  \/  |/ _ \|   \  |_   _| _ \  /_\ / __| |/ /_ _| \| |/ __|
 | |\/| | (_) | |) |   | | |   / / _ \ (__| ' < | || .` | (_ |
 |_|  |_|\___/|___/    |_| |_|_\/_/ \_\___|_|\_\___|_|\_|\___|
```

<p align="center">
  <strong>Claude Code mods that keep track of the work around your session.</strong><br>
  Issues, PRs, Jira items, links, worktrees and agents — in one live pane.
</p>

<p align="center">
  <a href="https://github.com/martin-macak/claude-code-mod-tracking/actions/workflows/test.yml"><img alt="test" src="https://github.com/martin-macak/claude-code-mod-tracking/actions/workflows/test.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/martin-macak/claude-code-mod-tracking/actions/workflows/lint.yml"><img alt="lint" src="https://github.com/martin-macak/claude-code-mod-tracking/actions/workflows/lint.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/martin-macak/claude-code-mod-tracking/actions/workflows/release.yml"><img alt="release workflow" src="https://github.com/martin-macak/claude-code-mod-tracking/actions/workflows/release.yml/badge.svg"></a>
  <a href="https://github.com/martin-macak/claude-code-mod-tracking/releases/latest"><img alt="latest release" src="https://img.shields.io/github/v/release/martin-macak/claude-code-mod-tracking?display_name=release&sort=semver"></a>
  <br>
  <a href="#requirements"><img alt="Claude Code 2.1.295 or newer" src="https://img.shields.io/badge/Claude%20Code-2.1.295%2B-D97757"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/martin-macak/claude-code-mod-tracking/commits/main"><img alt="last commit" src="https://img.shields.io/github/last-commit/martin-macak/claude-code-mod-tracking"></a>
  <a href="https://github.com/martin-macak/claude-code-mod-tracking/issues"><img alt="open issues" src="https://img.shields.io/github/issues/martin-macak/claude-code-mod-tracking"></a>
  <a href="https://www.conventionalcommits.org/en/v1.0.0/"><img alt="Conventional Commits" src="https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196"></a>
  <a href="#report-a-bug-or-ask-for-a-feature"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#report-a-bug-or-ask-for-a-feature">Report a bug</a> ·
  <a href="#development">Development</a> ·
  <a href="plugins/artifact-tracking/README.md">Full docs</a>
</p>

---

This repo holds Claude Code mods (function-hooks plugins) and the research behind them.

The first mod is [`artifact-tracking`](plugins/artifact-tracking/README.md). A session mentions GitHub issues and PRs, Jira work items, Claude artifacts and web links. The mod finds them, fetches their live state and shows them in a `/track` pane and in a band above the prompt. You stop losing the PR from an hour ago in the scrollback.

> [!NOTE]
> Mods are in early access. The API changes between Claude Code releases. This repo needs Claude Code 2.1.295 or newer.

## Demo

![artifact-tracking in a Claude Code session: a prompt mentions GitHub items and a link, the band counts them, /track shows their live state, Tab moves the selection, the 1 key moves the selected row to the top, and r refreshes](docs/assets/demo.gif)

You mention two PRs, an issue and a docs link in a normal prompt. The mod finds them, and the band above the prompt counts them, with `(1 ✗)` for the PR with failing checks. `/track` opens a pane with the live title, state and checks of each item from `gh`, and a section for web links. Tab moves the selection (a `>` and a highlight), and `1` marks the selected row high: the row moves to the top with `▲` and stays selected. Press `r` to refresh every item and `Esc` to close the pane.

The GIF comes from a Gherkin scenario, [`e2e/features/tracking.feature`](e2e/features/tracking.feature), that `make demo` records. The same scenario runs as a test under `make e2e-safe`.

## Features

- **Zero-effort capture.** Finds GitHub issue and PR URLs, `owner/repo#N`, bare `#N`, Jira URLs and web links in your prompts and in Claude's replies, also from subagents. Tool output gives explicit GitHub and Jira URLs only, and a Bash call of `acli jira workitem` adds the Jira item that it names.
- **Live state.** Shows title, open, closed or merged, failing checks, Jira status and the Epic tree. Data comes from `gh` (one GraphQL call for each host) and `acli`.
- **Always in view.** A one-line band above the prompt counts the items: `tracking  Jira 6 · GitHub 4 (1 ✗) · Links 2  /track`.
- **Interactive pane.** `/track` opens a pane with one section for each source, and a header row of column names in each. Tab and Shift+Tab move the selection. Enter opens a row: a leaf shows its full cells and its link. `r` refreshes, `x` hides the selected row, `h` shows every key, the config file and the problems, `Esc` closes. A long section ends in an `N more` row.
- **Priority.** Select a row and press `1` high, `2` normal, `3` low or `0` to remove your mark. Rows sort by level. The open PR of your current branch, and the issues it closes, rise on their own. `/track prio` does the same from the prompt.
- **Auto tracking.** Tracks the worktrees, agents and pull requests of the session with no mention, also stacked PRs and the refs in a PR body.
- **Survives restarts.** Keeps the items across `/clear`, `--resume` and `--continue`.
- **Fails soft.** Without `gh` or `acli`, the items stay in the list and the section says why. A circuit breaker pauses a failing tool for 5 minutes.
- **Private by design.** The mod stores only the extracted fields, never raw CLI output.

## Installation

### Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) 2.1.295 or newer, with mods.
- Optional: [`gh`](https://cli.github.com/) 2.102 or newer, logged in. It gives the live state of GitHub items.
- Optional: [`acli`](https://developer.atlassian.com/cloud/acli/) 1.3.19 or newer, logged in. It gives the live state of Jira items.

### From the marketplace (recommended)

In a Claude Code session:

```text
/plugin install artifact-tracking --marketplace martin-macak/claude-code-mod-tracking
```

Answer `y` to add the marketplace `mod-tracking`, then pick a scope. From a shell:

```bash
claude plugin install artifact-tracking --marketplace martin-macak/claude-code-mod-tracking
```

Get a new release:

```bash
claude plugin update artifact-tracking@mod-tracking
```

### From a release zip

Each [GitHub release](https://github.com/martin-macak/claude-code-mod-tracking/releases) attaches `artifact-tracking-<version>.zip`, a `SHA256SUMS` file and a build provenance attestation. Load a zip for one session:

```bash
claude --plugin-url https://github.com/martin-macak/claude-code-mod-tracking/releases/download/artifact-tracking--v<version>/artifact-tracking-<version>.zip
```

### From source

```bash
git clone https://github.com/martin-macak/claude-code-mod-tracking.git
cd claude-code-mod-tracking
claude --plugin-dir plugins/artifact-tracking   # one session
make install                                    # every session, as a symlink
```

## Usage

Work as usual. Mention issues, PRs, Jira keys and links in your prompts. The band fills by itself.

| Command | Action |
| --- | --- |
| `/track` | Opens the pane and refreshes the items that are due. |
| `/track refresh` | Refreshes every item and waits. Use it in `claude -p`. |
| `/track clear` | Removes all items of this session. |
| `/track help` | Prints every pane key, the config file path, the version and the problems (the first 50, then a count of the rest). Use it in `claude -p`. |
| `/track version` | Prints the version of the mod. Quote it in a bug report. |

The [mod README](plugins/artifact-tracking/README.md) lists every captured pattern, the auto-tracking rules, persistence and the known limits.

## Report a bug or ask for a feature

This project is young, and your feedback shapes it. A short report helps a lot. Did something break? Is a pattern missing? Do you want a new column or a new mod? Tell us.

- 🐛 [**Report a bug**](https://github.com/martin-macak/claude-code-mod-tracking/issues/new?template=bug_report.yml): state the symptom. Add your Claude Code version and the steps to reproduce.
- 💡 [**Ask for a feature**](https://github.com/martin-macak/claude-code-mod-tracking/issues/new?template=feature_request.yml): state the problem first, then your idea.
- 🧰 [**Propose a task**](https://github.com/martin-macak/claude-code-mod-tracking/issues/new?template=task.yml): tooling, CI, docs or refactoring.

Search the [open issues](https://github.com/martin-macak/claude-code-mod-tracking/issues) first, and add a 👍 to an issue that you also need. Pull requests are welcome too. See [Contributing](#contributing).

## Development

Requirements: `claude` 2.1.295 or newer, `mise` with `node@24`, and `pre-commit`. `gh` and `acli` are optional.

```bash
make init      # check the tools
make hooks     # install the git hooks (once per clone)
make test      # validate, type-check and test the mod
make install   # load the mod in every session
make e2e-safe  # run every Gherkin scenario except @artifacts against a real claude (local only)
make e2e       # the same, plus the @artifacts scenario (it publishes a private page to claude.ai)
make demo      # record docs/assets/demo.gif from the @demo scenario
```

`make e2e-safe`, `make e2e` and `make demo` also need `tmux`, `asciinema`, `agg` and `gifsicle` (`brew install tmux asciinema agg gifsicle`). They use the Claude login and trust store of the calling shell (`CLAUDE_CONFIG_DIR`, else `~/.claude`), and they run real model turns. To refresh the GIF, follow the [`demo-scenario`](.agents/skills/demo-scenario/SKILL.md) skill.

Run `make help` for every target.

### Layout

| Path | Content |
| --- | --- |
| [`plugins/`](plugins/) | The mods. One folder per mod. |
| [`e2e/`](e2e/) | Gherkin scenarios that drive a real `claude` in tmux (with a fake `gh` where a PR state is needed), the demo recorder and their tests. |
| [`docs/knowledge-base/`](docs/knowledge-base/AGENTS.md) | Research notes, one folder per problem. Start with `claude-code-mods/`. |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Design specs. |
| [`AGENTS.md`](AGENTS.md) | Rules for agents and contributors: lint, branches, commits, PRs, issues, planning and delivery. |
| [`Makefile`](Makefile) | Build, test, lint and install targets. |

### Lint

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

### CI/CD

| Workflow | Runs |
| --- | --- |
| [`test`](.github/workflows/test.yml) | `make test` and `make e2e-unit` on every PR and push to `main`. |
| [`lint`](.github/workflows/lint.yml) | The pre-commit hooks, the PR title check and the branch name check. |
| [`release`](.github/workflows/release.yml) | On a tag `<plugin>--v<version>`: validates, tests, builds the zip and publishes the GitHub release. |
| [`claude`](.github/workflows/claude.yml) | Claude answers `@claude` mentions. |

Release steps: [`plugins/artifact-tracking/README.md`](plugins/artifact-tracking/README.md#release).

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. In short: branch `<type>/<summary>`, Conventional Commits with a sentence-case subject, one PR per change with `Closes #N`, squash merge. Run `make verify` before you push.

The order of work is in the public [GitHub Project](https://github.com/users/martin-macak/projects/3). See [Planning and delivery](AGENTS.md#planning-and-delivery).

## License

[MIT](LICENSE) © Martin Macak
