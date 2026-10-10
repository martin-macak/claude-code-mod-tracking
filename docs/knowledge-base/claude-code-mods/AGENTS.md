# claude-code-mods knowledge base

Knowledge about Claude Code mods: plugins of **function hooks** (a TypeScript hooks module with `register(on, options)`). Pinned to **Claude Code 2.1.295**. The API is early access and changes between releases.

## Read order

1. `README.md` — index and status.
2. `concepts/overview.md` — the mental model.
3. `gotchas.md` — before you write any mod code.
4. `reference/` — look up exact names.

## Source of truth

- `sources/claude-code-2.1.295/types/claude-code.d.ts` is the authority. Grep it for the exact name (`'tool.call'`, `Pane: {`, `export type ToolCallResult`). Topic pages are a map, not the contract.
- If a topic page and the types file disagree, the types file wins. Fix the page.
- Public web docs never override the types file.
- Do not edit files under `sources/`. To refresh, see `sources/README.md`.

## Rules for editing this KB

- Cite claims as relative links with line anchors: `[d.ts:3955](../sources/claude-code-2.1.295/types/claude-code.d.ts#L3955)`.
- Mark inferences as *inference*. Put unknowns in `open-questions.md`.
- Write in loose ASD-STE100. Keep technical terms exact.

## Rules for building a mod here

- A mod is not a classic settings hook (`hooks` in `settings.json`, shell commands) and not `claude plugin init` output (that scaffolds command hooks). See `concepts/overview.md`.
- Run `claude plugin validate <mod>` early and often. Type-check with `tsc -p <mod>`. Test with `claude plugin test <mod>`.
- During a session, writing under the session's dev-mods folder raises the "Enable hot reloading" question. Only the user answers it.
