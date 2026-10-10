# docs/knowledge-base/

Research knowledge bases. One folder per problem, named by a kebab-case slug.

## Slugs

| Slug | Topic |
| --- | --- |
| [`claude-code-mods`](claude-code-mods/) | Claude Code mods: the function-hooks plugin API |
| [`claude-code-link-capture`](claude-code-link-capture/) | Capture every link Claude shows (Markdown, OSC 8) with a mod |
| [`claude-code-artifact-tracking`](claude-code-artifact-tracking/) | Track GitHub issues/PRs, Jira work items and web links in a session; enrich with `gh` and `acli`; show them in a pane |

## Convention for a slug folder

- `AGENTS.md` + `CLAUDE.md` symlink: rules for agents that use or edit the slug.
- `README.md`: index for humans, scope, version pin, status.
- `sources/<origin>-<version>/`: verbatim snapshots of primary sources. Never edit them. Refresh by adding a new versioned folder.
- Topic pages cite sources as relative links with line anchors, e.g. `[d.ts:3955](../sources/<folder>/types/claude-code.d.ts#L3955)`.
- Tag each claim's origin when it is not obvious: primary source, public docs, or inference.
- `open-questions.md`: what is unknown or unverified.

## Adding a slug

1. Create `<slug>/` with the files above.
2. Add a row to the table here.
