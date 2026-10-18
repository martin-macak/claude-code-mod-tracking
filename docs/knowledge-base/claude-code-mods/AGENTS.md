# claude-code-mods knowledge base

Knowledge about Claude Code mods: plugins of **function hooks** (a TypeScript hooks module with `register(on, options)`). Pinned to the **Claude Code 2.1.295** snapshot, with a checked delta for **2.1.302** (`reference/changes-2.1.302.md`). The API is early access and changes between releases.

## Read order

1. `README.md` — index and status.
2. `concepts/overview.md` — the mental model.
3. `gotchas.md` — before you write any mod code.
4. `concepts/lifecycle.md` and `concepts/ports-and-injection.md` — before you split a mod over several files or manage a session boundary.
5. `reference/` — look up exact names. `reference/changes-2.1.302.md` lists what moved since 2.1.295.

## Source of truth

- `sources/claude-code-2.1.302/types/claude-code.d.ts` is the authority: it is the newest snapshot and the installed version. Grep it for the exact name (`'tool.call'`, `Pane: {`, `export type ToolCallResult`). Topic pages are a map, not the contract.
- Older pages cite `sources/claude-code-2.1.295/types/claude-code.d.ts`. Their line anchors are right for that snapshot. Where the two snapshots differ, the 2.1.302 file wins. `reference/changes-2.1.302.md` lists the differences.
- `sources/spikes-2026-10-17/` holds the throwaway spike mods (source and small captures) behind the graded claims of the 2.1.302 pages, with one README row per spike. It is evidence, not product. Do not edit it.
- If a topic page and the types file disagree, the types file wins. Fix the page.
- Public web docs never override the types file.
- Do not edit files under `sources/`. To refresh, see `sources/README.md`.

## Rules for editing this KB

- Cite claims as relative links with line anchors: `[d.ts:3955](../sources/claude-code-2.1.295/types/claude-code.d.ts#L3955)`. Cite a new claim against the 2.1.302 file (`../sources/claude-code-2.1.302/types/claude-code.d.ts`). Keep existing 2.1.295 citations. Do not re-pin old anchors.
- Tag a new claim with its grade where it is not obvious: *verified-live* (an interactive session), *verified-kit* (`claude plugin validate`, `test`, `tsc`, or a headless `claude -p` run against a fake API), *types-only*, *inference*. A headless run is never *verified-live*. Put the exact output you saw next to a verified claim.
- Mark inferences as *inference*. Put unknowns in `open-questions.md`.
- Write in loose ASD-STE100. Keep technical terms exact.

## Rules for building a mod here

- A mod is not a classic settings hook (`hooks` in `settings.json`, shell commands) and not `claude plugin init` output (that scaffolds command hooks). See `concepts/overview.md`.
- Run `claude plugin validate <mod>` early and often. Type-check with `tsc -p <mod>`. Test with `claude plugin test <mod>`.
- During a session, writing under the session's dev-mods folder raises the "Enable hot reloading" question. Only the user answers it.
