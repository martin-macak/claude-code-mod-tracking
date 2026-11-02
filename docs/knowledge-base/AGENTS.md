# docs/knowledge-base/

Research knowledge bases. One folder per problem, named by a kebab-case slug.

## Slugs

| Slug | Topic |
| --- | --- |
| [`claude-code-mods`](claude-code-mods/) | Claude Code mods: the function-hooks plugin API |
| [`claude-code-link-capture`](claude-code-link-capture/) | Capture every link Claude shows (Markdown, OSC 8) with a mod |
| [`claude-code-artifact-tracking`](claude-code-artifact-tracking/) | Track GitHub issues/PRs, Jira work items and web links in a session; enrich with `gh` and `acli`; show them in a pane |
| [`claude-code-auto-tracking`](claude-code-auto-tracking/) | Auto tracking: find worktrees, agents and PRs relevant to a repository or branch; events, polling and feasibility |
| [`claude-code-mod-architecture`](claude-code-mod-architecture/) | Architecture of a multi-tracker mod: tree-table UI, config manager, tracker plugin contract, lifecycle manager, delivery as stacked PRs |

## Convention for a slug folder

- `AGENTS.md` + `CLAUDE.md` symlink: rules for agents that use or edit the slug.
- `README.md`: index for humans, scope, version pin, status.
- `sources/<origin>-<version>/`: verbatim snapshots of primary sources. Never edit them. Refresh by adding a new versioned folder.
- Topic pages cite sources as relative links with line anchors, e.g. `[d.ts:3955](../sources/<folder>/types/claude-code.d.ts#L3955)`.
- A link with a line anchor into repo code (not into `sources/`) carries a title with the start of that line (at least 8 characters, no `"`, not only `/**`): `[shell.ts:199](../../plugins/example/shell.ts#L199 "export function splitShell")`. The contract test `scripts/contracts/kb-code-links.test.mjs` (in `make test-scripts`) fails when the line no longer holds the text. A PR that moves a linked line remaps the link. Take the excerpt from the line that the sentence relies on, and make it name one line in its file. The end line of a range is not checked. A link to a missing file fails. The scan skips a link into `plugins/example/` (a doc example). The link text may name the same numbers (`shell.ts:199`); they must equal the anchor.
- Tag each claim's origin when it is not obvious: primary source, public docs, or inference.
- `open-questions.md`: what is unknown or unverified.

## Adding a slug

1. Create `<slug>/` with the files above.
2. Add a row to the table here.
