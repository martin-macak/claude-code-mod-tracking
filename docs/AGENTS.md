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
