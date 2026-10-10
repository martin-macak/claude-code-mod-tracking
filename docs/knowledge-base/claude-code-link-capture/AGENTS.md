# claude-code-link-capture knowledge base

How a Claude Code mod captures, reliably, every link that Claude shows the person. Pinned to **Claude Code 2.1.295**.

## Prerequisite

Read the mods KB first: `../claude-code-mods/AGENTS.md`, then `../claude-code-mods/concepts/overview.md` and `../claude-code-mods/gotchas.md`. This slug does not repeat mod basics.

## Layout

- `README.md` — the page: where links live, capture points, recommended design, reliability checklist.
- `example/link-capture/` — a reference mod. It passes `claude plugin validate`, `tsc` and `claude plugin test` on 2.1.295. `example/tsconfig.json` type-checks it against the mods KB's types snapshot.
- `sources/` — the OSC 8 spec snapshot and `live-observations-2026-10-10/` (scripts and recorded runs behind every *observed* claim). Mod API facts link into `../claude-code-mods/sources/`.
- `open-questions.md` — unknowns.

## Rules

- The mods types file `../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts` is the authority for API facts.
- After any change to `example/`, re-run `validate`, `tsc` and `test`. Update the commands and results in `README.md`.
- `example/` is not loaded by Claude Code. To try it in a session: `claude --plugin-dir docs/knowledge-base/claude-code-link-capture/example/link-capture`.
- Cite as relative links with line anchors. Mark guesses as *inference*. Write in loose ASD-STE100.
