# claude-code-artifact-tracking knowledge base

Research for a Claude Code mod that tracks GitHub issues and PRs, Jira work items and web links mentioned in a session, enriches them with `gh` and `acli`, and shows them in a pane. Pinned to **Claude Code 2.1.295** (cross-checked on 2.1.296), **gh 2.102.0**, **acli 1.3.19-stable**.

## Read order

1. `../claude-code-mods/AGENTS.md`, then `../claude-code-mods/gotchas.md`. Mod basics live there.
2. `../claude-code-link-capture/README.md`. The capture hooks and the scanner live there.
3. `README.md` here: scope, pins, the flow diagram, key findings.
4. The topic page you need: `mod-api-notes.md`, `github.md`, `jira.md`, `reference-patterns.md`.
5. `open-questions.md` before you design: it holds the decisions the user still has to make.

## Source of truth

- Mod API: `../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts`. It wins over any page here.
- `gh` facts: `sources/gh-2.102.0/`. `acli` facts: `sources/acli-1.3.19/` and `sources/acli-docs-2026-10-10/`.
- Live mod observations: `sources/live-observations-2026-10-10/` (a probe mod, its tests, and recorded runs).
- Live smoke run of the finished mod: `sources/live-smoke-2026-10-10/` (headless runs, a REPL run with a real `/clear`).
- Never edit files under `sources/`. To refresh, add a new versioned folder (for example `sources/acli-1.3.39/`).

## Rules for editing this slug

- Tag each claim: *primary* (types file, CLI `--help`, live schema), *observed* (a live run saved under `sources/`), *public-docs*, or *inference*.
- Cite as relative links to the saved file, with a line anchor when the file is long.
- Put unknowns in `open-questions.md` §3 and user choices in §4. Keep the D and N numbers stable; add new ones at the end.
- Write in loose ASD-STE100. Embed diagrams as Mermaid.

## Safety rules for new probes

- Run only read-only `gh` and `acli` commands. Never create, edit, comment on, transition or delete a GitHub or Jira object.
- Never run `gh auth login/logout`, `acli jira auth login/logout/switch`, or any install or upgrade.
- Simulate "not logged in" with an empty `GH_CONFIG_DIR` or `HOME`. Simulate "network down" with `HTTPS_PROXY=http://127.0.0.1:9`.
- Never print or save tokens. Redact account names, emails, Jira sites (`<site>`), and personal data in public issue titles before you save a snapshot.

## Rules for building the mod from this slug

- Only `register.ts` touches `$`. It hands closures such as `(argv, init) => $.process.run(argv, init)` to plain classes. `validate` rejects `$` passed to an imported function, to a class or to a method (a same-file top-level function is accepted).
- Keep `TrackedItem`, `Tool`, `CircuitBreaker` and the scanner free of `$`. Unit-test them with a fake runner. Use the kit only for wiring.
- Read the decisions in `open-questions.md` §4 before you write code. Do not pick an option the user has not confirmed.
