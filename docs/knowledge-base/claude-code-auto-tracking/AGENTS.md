# claude-code-auto-tracking knowledge base

Research for "auto tracking": a Claude Code mod feature that finds the items relevant to a repository or branch by itself. The items are worktrees, agents (sessions) and pull requests. The mod adds them to the `/track` pane of the [artifact-tracking mod](../claude-code-artifact-tracking/README.md). Pinned to **Claude Code 2.1.296** (installed) with the **2.1.295** type file, **git 2.56.0**, **gh 2.102.0**.

## Read order

1. `../claude-code-mods/AGENTS.md`, then `../claude-code-mods/gotchas.md`. Mod basics live there.
2. `../claude-code-artifact-tracking/AGENTS.md` and its `mod-api-notes.md`. The existing mod, its timers, state and pane live there.
3. `README.md` here: scope, pins, the requirement, key findings.
4. `feasibility.md`: the matrix. One row per requirement item.
5. The topic page you need: `worktrees.md`, `agents-and-sessions.md`, `pull-requests.md`, `triggers-and-polling.md`.
6. `open-questions.md` before you design. It holds the decisions the user still has to make.

## Source of truth

- Mod API: `../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts`. It wins over any page here.
- Git facts: `sources/git-2.56.0/`. `gh` facts: `sources/gh-2.102.0/`. Claude Code CLI facts: `sources/claude-code-2.1.296/`.
- Live mod probe (events, `$.store` sharing, the managed-hook bypass): `sources/live-probe-2026-10-10/`.
- Review probe (two live sessions, the `WorktreeCreate` fallback, worktree location): `sources/live-probe-2026-10-10-review/`.
- Never edit files under `sources/`. To refresh, add a new versioned folder.

## Rules for editing this slug

- Tag each claim: `[primary source]` (types file, CLI help), `[public docs]`, `[observed]` (a run saved under `sources/`), or `[inference]`.
- Cite as relative links to the saved file, with a line anchor when the file is long.
- Do not repeat the mods KB or the artifact-tracking KB. Link them.
- Put unknowns in `open-questions.md` §3 and user choices in §4. Keep the D and N numbers stable; add new ones at the end.
- Write in loose ASD-STE100. Embed diagrams as Mermaid.

## Safety rules for new probes

- Run only read-only `gh` commands. Never create, edit, comment on or close a GitHub object.
- Use a throwaway git repo for worktree experiments. Never create a worktree in this repo for a probe.
- Do not read `~/.claude*/sessions/*.key` files. They hold peer tokens.
- Do not save tokens, emails or other sessions' names and paths.
- A probe mod must not return `worktreePath` from `classic.WorktreeCreate`. That replaces Claude's own worktree creation.

## Rules for building the feature from this slug

- Build on engine events and polling first. Treat `classic.*` hooks as an optional fast path ([triggers-and-polling §2](triggers-and-polling.md#2-the-managed-bypass-of-classic-hooks)).
- Do not ship a `classic.WorktreeCreate` hook until open question N1 passes.
- Read the decisions in `open-questions.md` §4. Do not pick an option the user has not confirmed.
