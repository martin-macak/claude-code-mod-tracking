# docs/

Project documentation.

## Layout

- `knowledge-base/` — research notes, one folder per problem. See `knowledge-base/AGENTS.md`.

## Rules

- Write in loose ASD-STE100: short active sentences, one idea per sentence.
- Diagrams: embed Mermaid in the `.md` file. Prefer UML (sequence, state, component).
- Use relative links between docs.

## Tests

- A kit test checks order or causality, not wall time. Hold the fake call open and check which side returns first.
  - Keep a time budget only where time is the point, and make it relative with `expectLinear`. The header of `plugins/artifact-tracking/tests/fixtures/scaling.ts` has the rules.
  - A kit test that takes `$` imports `test` from `plugins/artifact-tracking/tests/fixtures/kit.ts`. It sets a 30 s hang guard in place of the 5 s kit limit.
- An e2e check or scenario waits for an event, or for a condition relative to one, not for a fixed time after a start. Examples: a call in the fake gh log, then a quiet log (`the fake gh has been quiet for N seconds`); a count of reads, not a window; an age that is younger than the age noted before. A timeout is a hang guard, never the fix for a flake.
  - Show a fix for a load flake by forcing the slow case. Stop a child with `SIGSTOP` (a committed test can do it). Or hold a fake call back with a temporary edit of `e2e/fake-gh/main.ts` and revert it: the fake has no hold option, so say in the PR what you held and for how long. The old check must fail and the new one must pass.
