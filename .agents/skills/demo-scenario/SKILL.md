---
name: demo-scenario
description: Use when the README demo GIF of the artifact-tracking mod must be made or refreshed, when a demo or E2E Gherkin scenario in e2e/features must be written or fixed, or when the README demo section must be updated.
---

# Demo scenario

Make the README demo GIF from a Gherkin scenario that also runs as an E2E test.

**Core rule:** read the live screen before you write an assertion. Assert on mod output (band, pane), never on Claude's words.

## Parts

| Part | Where |
| --- | --- |
| Scenarios | `e2e/features/*.feature`. Exactly one scenario has the `@demo` tag. |
| Steps | `e2e/steps/*.steps.ts`. Reuse before you add. |
| Live explorer | `cd e2e && mise exec node@24 -- node bin/drive.ts start [prompt] \| type <text> \| key <name> \| wait-turn \| screen \| caption <text> \| stop` |
| Run as tests | `make e2e-safe`: every scenario except `@artifacts` (real model turns, local only). `make e2e` adds the `@artifacts` scenario. One scenario, the lock and the env vars: `e2e/README.md` |
| Record | `make demo` writes `docs/assets/demo.gif`, at most 2 MB |
| Design | `docs/superpowers/specs/2026-10-11-demo-pipeline-design.md` |

## Steps you have

| Step | GIF effect |
| --- | --- |
| `Given the caption "…"` | Sets the caption bar. |
| `Given a terminal of N columns by M rows` | Hidden. Sets the terminal size of the scenario, for example 100 by 40, where the pane is inline. Put it before the session step. Not for `@demo`. `DEMO_COLS` and `DEMO_ROWS` (120 by 36) stay the default. |
| `Given a Claude Code session with the artifact-tracking mod` | Hidden (cut). Handles the trust dialog. |
| `Given a Claude Code session with the artifact-tracking mod and the prompt "…"` | Hidden, then the turn is sped up. |
| `When I type "…"` | Real typing, then Enter. |
| `When I press "…"` | One tmux key: `Enter`, `Escape`, `Down`, `r`. |
| `When Claude finishes` | Sped up to about 1 s. Only after a prompt, never after `/track`. |
| `When I wait for N seconds` | Sped up. |
| `When I pause for N seconds` | Real time, at most 5 s. Put 1.5–3 s after each `Then` the viewer must read: the next step types at once. |
| `Then the screen shows "…"` / `matches /re/` | Polling is sped up. Fails after 20 s with the last screen. |
| `Then the screen stops showing "…"` | Polls until the text is gone, for example a pane after Esc. |
| `Then the pane stops showing "…"` | Polls until the pane no longer draws the text. It reads the pane only (right of the first border), so a transcript line that still holds the text, such as the `/track` line with `#7`, does not hold it up. Use it for a row that the pane drops. |
| `Then the screen does not show "…"` | One check, no wait. Only for text that can never appear. |
| `Then no permission dialog is open` | Fails if a tool approval opened. |
| `Given the tracker config file:` (doc string) | Hidden. Writes the scenario's `config.json` before the session starts. Every scenario has its own empty config folder. |
| `Given the tracker config file path is N cells wide` | Hidden. Gives the path of `config.json` that width, so the rows of the help view do not depend on the temporary folder of the system. Put it before the step that writes the file. |
| `Then the pane is docked` / `Then the pane is inline` | Polls the screen for the close mark `✕` of the pane. Use it when a scenario runs at two sizes, so a size that did not take effect fails. |
| `Then the tracker config file sets "a.b" to "json"` | Polls the file for the value at the dotted path, for example `"trackers.web.enabled"` to `"false"`. |
| `When I press "…" until the screen matches /re/, then Claude finishes` | Presses the key every second until the screen matches, then waits for the turn it started. For a key that sends a prompt but can do nothing at first, such as the resolve key `c`, which needs the PR lane to have looked at the PR. |
| `Given a fake GitHub repo "owner/repo" with the clone on the branch "…"` | Hidden. Puts the clone on a feature branch (PR discovery drops the default branch), makes its `origin` a local copy and puts the fake `gh` on the `PATH` of the session. Not for `@demo`: the demo uses live data. |
| `Given the fake gh reports PR #N "title" from "head" into "base" as CONFLICTING` | Hidden. Adds a PR to the fake. The last word is `CONFLICTING`, `MERGEABLE` or `UNKNOWN`. |
| `Then the fake gh answered "call"` | Polls the fake's log, for example `"graphql discovery"` or `"--version"`. Shows that the session ran the fake and not the real `gh`. |
| `When the fake gh has been quiet for N seconds` | Sped up. Polls until the log of the fake has had no new call for N seconds, counted from the last call. Use it after `the fake gh answered "call"` to know that the first calls of the mod are over, instead of `I wait for N seconds` from the start of the session: the start takes longer on a loaded machine. A log with no call is never quiet, so the step cannot pass before the fake got its first call. |
| `When I note how old the last refresh on the screen is` | Polls for a section note (`gh · refreshed 3s ago`) and keeps its age. Fails when the age is `just now`: the pane draws the age when it draws, so the scenario must wait before it opens the pane. |
| `Then the last refresh on the screen is younger than the one noted` | Polls until the section note is younger than the noted age: a key refreshed. Use it in place of `refreshed just now`, which says "less than 1 s" and fails when a slow draw ages the refresh. |
| `Then the fake gh answered no unsupported call` | Fails when the fake got no call, or one it does not know. |
| `Then the fake origin got no push` | Fails when a ref of the local copy of the origin changed. Use it after a step that makes the session act on its own. |
| `Given a fake model that asks "q" under the header "h" with the options "a" and "b"` | Hidden. The model of the session is a script (`e2e/support/fake-api.ts`): Claude asks that one question with `AskUserQuestion`, then says `Noted.`. The session runs in a config folder of its own, with a fake token, so it needs no login. Put it before the step that starts the session. Not for `@demo`. |
| `Then the fake model was told "text"` | Polls what the engine told the model about its tools, for example the answer of a dialog. Shows that the dialog of the real session ran. |

## Loop

1. **Learn.** Read `plugins/artifact-tracking/README.md` and the specs in `docs/superpowers/specs/`. List the user-visible features. Rank them by how well each shows in a few seconds.
2. **Explore.** `drive.ts start`, then try each candidate beat. After each action run `screen` and copy the exact text you will assert on. Always `drive.ts stop` at the end, also after an error.
3. **Pick 3–4 beats** for 30–45 s of play time. One idea per beat.
4. **Write the scenario.** A caption before each beat. Together the captions tell the story.
5. **Add a step only if none fits.** It must set a phase: `cut` for setup, `fast` for waits, `normal` for what the viewer must see.
6. **`make e2e-safe` until it passes.** Do not record before that. `make e2e-safe` skips the `@artifacts` scenario, which publishes a private page to claude.ai. `make e2e` runs it too: use it after a change to the artifact tracker or to that scenario (`AGENTS.md`, "Lint and hooks"). For a loop on your own scenario run `npx cucumber-js -p one features/x.feature:N` in `e2e/` and add `--dry-run` first to see what runs (see `e2e/README.md`: a bare `features/x.feature:N` also runs every other feature file). Only `-p artifacts` and `-p all` select `@artifacts`. A run that finds the lock of another run waits for it (up to 30 minutes) and prints who holds it. Never remove the lock and never kill the other run.
7. **`make demo`, then look at it.** Pull frames and read each one:
   `ffmpeg -loglevel error -i docs/assets/demo.gif -vf "select='not(mod(n\,10))'" -fps_mode vfr <scratchpad>/frame-%02d.png`
   (`-vsync` no longer exists in ffmpeg 8). Check the list in "Frame check". Fix and record again until it passes.
8. **README.** The "Demo" section: the GIF, a 3–5 sentence narrative that follows the captions, a feature list. Loose ASD-STE100 prose.
9. **Clean up.** Delete the frames. Commit the feature, new steps, the GIF and the README together.

## Frame check

- Captions match the beat on screen.
- Every asserted state stays readable for at least 1.5 s.
- No long dull stretch: model waits take about 1 s.
- No personal data. Seen on Claude Code 2.1.296:
  - the plan name in the banner (`Claude Max`, `Claude Pro`),
  - usage notices (`You've used 90% of your weekly limit`),
  - home paths, emails, org names.
  The render step blanks known patterns (`REDACTIONS` in `e2e/render/render.ts`), then fails `make demo` when a `LEAKS` pattern still shows. On that failure, add a redaction with a test. Never loosen `LEAKS`. Your frame check is the second line for data no pattern knows yet.

## Screen facts (Claude Code 2.1.296)

| Fact | Effect |
| --- | --- |
| The trust dialog selects "No, exit" first. | Launch moves to "Yes" first. Never press a bare Enter there. |
| The prompt line is `❯` + no-break space. | Regexes use `\s`, not a literal space. |
| `/track` writes states in lower case (`merged`, `closed`). | Copy the exact text from `screen`. |
| The pane's "refreshed Ns ago" is fixed at render time. It changes only on a refresh. | To prove a refresh, first assert `refreshed \d+s ago` in the pane line (`│GitHub gh · …`), then `refreshed just now`. |
| The band and the pane can show the same words. | Anchor a pane assertion on the pane border `│`. |
| The band reads like `tracking GitHub 1 (1 ✗) /track`. | `(n ✗)` counts failing checks. Allow it in regexes. |
| A bare `#N` of a closed issue is gated out. | Use full GitHub URLs. |
| The session has no tool (`--tools ''` and `--strict-mcp-config`), so a prompt that asks for a command gets words, not a run. | A scenario that needs a tool uses the step with `and the tools "…"`, and plans for every call the tool makes (the fake gh answers few). |
| A prompt that invites a tool ("look at", "fetch") may open a dialog, in a session that has tools. | "Note X for later. Reply ok." |
| A `gh` first on the `PATH` of claude also answers claude. Claude Code itself runs `gh auth token` at start. | The fake gives no token. `e2e/fake-gh` and spec section 14 hold the rest. |
| An Esc aborts the turn, and the Stop hook does not run for an aborted turn. | After an Esc do not use `Claude finishes`. Wait for the screen: `matches /for \d+s · done/`. |
| The result of a tool is not in the last message of the next request: the engine adds a message of its own after it. | `e2e/support/fake-api.ts` reads every `tool_result` block of the body, each once. |

## Red flags

- You write an assertion you did not see in `drive.ts screen` output.
- You loosen a regex until it passes.
- You skip the frame check because `make demo` passed.
- The GIF is above 2 MB and you raise the budget. Cut a beat instead.
- Two scenarios carry `@demo`.
