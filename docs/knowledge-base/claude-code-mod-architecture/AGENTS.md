# claude-code-mod-architecture knowledge base

Research for [issue #55](https://github.com/martin-macak/claude-code-mod-tracking/issues/55): restructure the [artifact-tracking mod](../claude-code-artifact-tracking/README.md) so that a new tracker is a new folder. The topics are a tree-table UI component, a config manager, a tracker plugin contract, one lifecycle manager and delivery as stacked pull requests. This slug is research. It is not the design spec. The spec goes to `docs/superpowers/specs/`.

## Read order

1. `../claude-code-mods/AGENTS.md`, then `../claude-code-mods/gotchas.md`. Mod basics live there.
2. `README.md` here: scope, pins, key findings, map.
3. `current-architecture.md`: the as-is map of the mod. Read it before any option page.
4. The option page you need: `tree-table.md`, `config-manager.md`, `tracker-plugins.md`, `lifecycle-manager.md`, `stacked-prs.md`.
5. `open-questions.md` before you write the spec. It holds the unknowns and the decisions the user still has to make.

## Source of truth

- Mod API: `../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts` (Claude Code 2.1.302, installed). It wins over any page here.
- Older pages in `../claude-code-mods/` cite the 2.1.295 snapshot. Its 2.1.302 pages cite the new one. Do not re-pin the old anchors from this slug. If a 2.1.302 fact contradicts them, list it in [open-questions §3](open-questions.md#3-older-kb-claims-this-slug-contradicts).
- The mod under study is `plugins/artifact-tracking/` at commit [d391552](https://github.com/martin-macak/claude-code-mod-tracking/commit/d391552bfb5ebe18febc24b81f8dd914e1127a47). Line numbers in `current-architecture.md` are for that commit. They drift. Re-check them before you edit code.
- The spikes (small throwaway mods) that back the `verified-*` grades are snapshotted in `../claude-code-mods/sources/spikes-2026-10-17/` (source files and small captures, one README row per spike). Each claim still carries the output that matters, so a page reads alone. Link a spike by its folder in the snapshot. Never link a scratch path.

## Grades

Tag each new claim with one grade, where the grade is not obvious. A table has a Grade column instead.

| Grade | Meaning |
| --- | --- |
| `verified-live` | Seen in a real interactive Claude Code session (tmux), with captured output. |
| `verified-kit` | Seen in `claude plugin validate`, `claude plugin test` or `tsc`. A headless `claude -p` run against a fake API counts here, not as live. |
| `types-only` | Stated by the 2.1.302 d.ts or its `reference.md`. Not run. |
| `public-docs` | Stated by public web docs or a changelog. Not run. Weaker than `types-only`. |
| `observed` | Output of a real command in a non-interactive shell on this machine or this repo (for example `gh api` or `gh stack`). The page quotes it. It is not `verified-live` (no interactive Claude session) and not `verified-kit` (no `validate`, `test`, `tsc` or `claude -p`). |
| `inference` | Reasoning from the facts above. Every recommendation is `inference`. |
| `unresolved` | A probe could not settle it (a step failed, or the output cannot tell). The question also stays open in `open-questions.md`. |

`public-docs`, `observed` and `unresolved` extend the four grades of the research task (`verified-live`, `verified-kit`, `types-only`, `inference`). Where a command (not a Claude session) produced the output, use `observed`. Do not read it as `verified-live`. The older slugs use `[primary source]`, `[public docs]`, `[observed]` and `[inference]`. Do not mix the two sets inside one page.

## Rules for editing this slug

- Cite engine claims as relative links with line anchors: `[d.ts:3472](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L3472)`.
- Present options with trade-offs. Mark each recommendation: **Recommendation (inference):**. Never write a recommendation as a decision. A decision the user made in the issue is recorded as **Decided (Dn, date):**, and the earlier **Recommendation (inference):** stays beneath it.
- Do not repeat the mods KB. Link it.
- Put unknowns in `open-questions.md`. Keep the Q, D and C numbers stable. Add new ones at the end.
- Write in loose ASD-STE100: short active sentences, one idea per sentence. Keep technical terms exact.
- Embed diagrams as Mermaid. Prefer UML.
- Every page must stand alone. Do not link to scratch files or to a path under `/private/tmp`. Link a spike by its folder in the snapshot, and quote the output that matters.

## Safety rules for new probes

- Never write under `~/.claude-personal/dev-mods/`. That raises the hot-reload question, and only the user answers it.
- Load a probe mod with `claude --plugin-dir <scratch folder> --setting-sources project`. Use a private tmux server (`tmux -L <name>`) and kill it afterwards.
- A `claude` started from inside a Claude Code shell inherits `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and other session variables. Remove them with `env -u` and keep `CLAUDE_CONFIG_DIR`.
- A probe that writes under `~/.config/claude-code/mods/` must delete its own folder afterwards.
- Prefer a fake API for headless runs. Start no paid model turn.

## Rules for building the feature from this slug

- Read the decisions in `open-questions.md` §2. Do not pick an option the user has not confirmed.
- The kit does not show paint, the focus ring or the arrow keys. A UI claim needs a live run.
- Run `claude plugin validate` before you trust a kit result. A scan error shows in the kit as `HooksError: ... hooks module did not load`.
