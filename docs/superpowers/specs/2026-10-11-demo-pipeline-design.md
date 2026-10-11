# Demo pipeline: design

Status: implemented 2026-10-11. Branch: `feat/demo-pipeline`.

## 1. Goal

`make demo` records a real Claude Code session that uses the `artifact-tracking` mod. It writes a small animated GIF for the README. The same scenario files also run as local end-to-end (E2E) tests under `make e2e`.

Three parts:

- **Harness.** Gherkin feature files with TypeScript step definitions. They drive a real `claude` in tmux and assert on the screen.
- **Recorder.** asciinema records the session. A retime step speeds up or cuts dull phases. `agg` renders the GIF. Captions come from the scenario and stay in sync.
- **Skill.** `demo-scenario` tells an agent how to explore the mod, write the `@demo` scenario, add missing steps, record the GIF and update the README.

### 1.1 Non-goals

- E2E in CI. CI has no Claude login, and a real model costs money on each run.
- Stubbed `gh` or `acli`. The demo uses this repo's live issues and PRs.
- A deterministic model. The scenario asserts on mod output (band, pane), not on Claude's words.
- Prompt delivery over a socket or the local peer channel. Peer prompts render as teammate messages, not as typed input.
- Video formats other than GIF. Several GIFs per README.
- A Gherkin linter.

## 2. Decisions

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Cucumber-js with TS steps, run by Node 24 type stripping. | Standard Gherkin runner. No build step, same as the plugin. Fallback: `tsx` loader if Cucumber cannot `--import` `.ts` that way. |
| D2 | Prompts go in through `tmux send-keys`, one character at a time. | It shows real typing in the GIF. The recording already runs through tmux. |
| D3 | The session runs with `--setting-sources project --plugin-dir <clone>/plugins/artifact-tracking`. | It keeps the OAuth login but skips user hooks, plugins and statusline. `--bare` needs an API key. |
| D4 | A `Stop` hook passed with `--settings` signals turn end. | Probed on 2.1.296: the hook fires under `--setting-sources project`. More exact than screen scraping. |
| D5 | The session runs in a fresh clone at a short, neutral path, with the real `origin`, on branch `main` at our `HEAD`. `--plugin-dir` points at the working-tree plugin (`<repo>/plugins/artifact-tracking`). | It hides home paths. `#N` still resolves to this repo. A clone has no `.claude/skills/artifact-tracking` link, so the mod loads once. Uncommitted mod changes are part of the run. |
| D6 | Captions live in the tmux status line as `#{@caption}`. | They are part of the cast, so every retime keeps them in sync. No font or video pipeline. |
| D7 | Steps tag phases (`cut`, `fast`, `normal`) in a timeline file. A retime step rewrites the cast. | The Claude spinner redraws all the time, so idle cutting alone saves nothing during a model turn. |
| D8 | Model: `$DEMO_MODEL`, default `haiku`. | Short waits, low cost. |
| D9 | Live data from this repo. | Authentic status. Risk: the GIF changes when the data changes (section 11). |
| D10 | GIF budget 2 MB. Output: `docs/assets/demo.gif`. | Readable on GitHub. `make demo` fails above the budget. |

Probe results, 2026-10-11, Claude Code 2.1.296:

- `--settings '{"hooks":{"Stop":[…]}}'` with `--setting-sources project`: the hook wrote its line.
- `--plugin-dir` beside the `.claude/skills/artifact-tracking` link: the `--plugin-dir` copy loads. The link copy is rejected with "name already taken" in the debug log.
- tmux 3.8 has `allow-set-title`.
- The workspace trust dialog lists "No, exit" first and selects it. A bare Enter quits.
- The idle prompt line starts with `❯` and a no-break space (U+00A0).
- asciinema 3.2.1 `rec --headless` records a `tmux attach` client.
- Cucumber 13.3.0 loads the `.ts` steps with Node 24 type stripping. No loader is needed.
- The banner shows the plan name (`Claude Max`). A usage notice shows the use, the reset time and the time zone.

## 3. Architecture

### 3.1 Components

```mermaid
flowchart LR
  subgraph Cucumber
    F[features/*.feature] --> S[steps/*.steps.ts]
    S --> W[DemoWorld]
  end
  W --> T[Tmux]
  W --> C[ClaudeSession]
  W --> L[Timeline]
  W --> R[Recorder]
  C -->|launch in pane| T
  R -->|asciinema rec of tmux attach| T
  C -.->|Stop hook appends| SIG[(signal file)]
  R --> CAST[(session.cast)]
  L --> TL[(timeline.ndjson)]
  CAST --> RT[retime.ts]
  TL --> RT
  RT --> AGG[agg]
  AGG --> GS[gifsicle]
  GS --> GIF[(docs/assets/demo.gif)]
  D[bin/drive.ts] --> T
  D --> C
```

| Unit | Does | Depends on |
| --- | --- | --- |
| `Tmux` | Starts a private server (`tmux -L <name>`). Sets the size, the status line and the caption. Sends keys. Captures the pane as plain text. Kills the server. | `tmux` |
| `ClaudeSession` | Makes the clone. Builds the `claude` command line and the `--settings` JSON. Watches the signal file. | `git`, `Tmux` |
| `Recorder` | Starts and stops `asciinema rec` on `tmux attach`. No-op when recording is off. | `asciinema` |
| `Timeline` | Appends phase and sync events with wall-clock times. | none |
| `DemoWorld` | Cucumber World. Owns one of each unit per scenario. `Before` and `After` hooks. | all above |
| `retime.ts` | Pure function: cast plus timeline in, cast out. | none |
| `render.ts` | CLI: retime, then `agg`, then `gifsicle`, then a size check. | `agg`, `gifsicle` |
| `drive.ts` | CLI for the skill's exploration. Same `Tmux` and `ClaudeSession` code, state kept in `e2e/out/drive/`. | `Tmux`, `ClaudeSession` |

### 3.2 Files

```text
e2e/
  package.json          @cucumber/cucumber, @types/node; npm scripts
  package-lock.json
  tsconfig.json         noEmit, erasableSyntaxOnly, strict
  cucumber.mjs          profiles: default (e2e), demo (record, tags @demo)
  features/
    tracking.feature    written by the skill
  steps/
    session.steps.ts
    prompt.steps.ts
    screen.steps.ts
    narrative.steps.ts
  support/
    config.ts           env to config, defaults
    tmux.ts
    session.ts
    slug.ts             scenario name to folder name
    drive.ts            the drive CLI commands
    recorder.ts
    timeline.ts
    world.ts            DemoWorld, Before and After hooks (needs the Cucumber runtime)
  render/
    cast.ts             asciicast v2 parse and write
    retime.ts
    render.ts
  bin/
    drive.ts
  tests/
    *.test.ts           node:test, one file per support or render module
  out/                  git-ignored: casts, timelines, screen dumps
docs/assets/demo.gif
.agents/skills/demo-scenario/SKILL.md
.claude/skills/demo-scenario -> ../../.agents/skills/demo-scenario
```

### 3.3 Configuration

| Env var | Default | Use |
| --- | --- | --- |
| `DEMO_RECORD` | `0` (`1` in the `demo` profile) | Turns the recorder on. |
| `DEMO_MODEL` | `haiku` | `--model` value. |
| `DEMO_DIR` | `/tmp/cc-demo` | Parent of the clone. The clone is `$DEMO_DIR/claude-code-mod-tracking`. |
| `DEMO_COLS`, `DEMO_ROWS` | `120`, `36` | Pane size. The tmux client is one row taller for the status line. 120 columns keeps the `/track` pane from waiting on a narrow terminal. |
| `DEMO_TYPE_DELAY_MS` | `35` | Delay between typed characters. |
| `DEMO_TURN_TIMEOUT_S` | `120` | Upper bound for one model turn. |
| `DEMO_SCREEN_TIMEOUT_S` | `20` | Upper bound for one screen assertion. |
| `DEMO_KEEP` | `0` | `1` keeps the clone and the tmux server after the run. |

## 4. Session lifecycle

```mermaid
sequenceDiagram
  participant Cu as Cucumber
  participant W as DemoWorld
  participant T as tmux -L demo
  participant A as asciinema
  participant Cl as claude
  Cu->>W: Before
  W->>W: clone repo to $DEMO_DIR, set origin
  W->>T: new-session -d -x 120 -y 37, status line on
  opt DEMO_RECORD=1
    W->>A: rec --headless -f asciicast-v2 -c "tmux attach"
  end
  W->>T: set @caption SYNC-nonce, timeline sync event, phase cut
  Cu->>W: Given a session with the mod
  W->>T: send-keys claude ... Enter
  T->>Cl: start
  W->>T: wait for prompt box, accept trust dialog if shown
  Cu->>W: When I type "..."
  W->>T: phase normal, send-keys per char, Enter
  Cu->>W: And Claude finishes
  W->>W: phase fast, wait for a new line in the signal file
  Cl-->>W: Stop hook appends "stop"
  Cu->>W: Then the screen shows /re/
  W->>T: phase normal, poll capture-pane until match or timeout
  Cu->>W: After
  W->>A: stop (detach the client)
  W->>T: kill-server, remove clone unless DEMO_KEEP=1
```

### 4.1 Before

1. Take the run lock in `<os tmpdir>/cc-demo-lock` (one lock for the fixed tmux socket). Only then wipe and make the scenario folder: `e2e/out/<scenario-slug>/` for `make e2e`, `e2e/out/demo/` when recording. It holds `signal`, `timeline.ndjson`, `session.cast` and failure dumps. A second run fails on the lock and touches no file of the first run.
2. `git clone --quiet <repo root> $DEMO_DIR/claude-code-mod-tracking`, after a wipe of the old folder. Set `origin` to the URL of the checkout under test. Check out the current `HEAD` as branch `main`.
3. Start the tmux server and session with these options: `status on`, `status-position top`, `status-left ''`, `status-right ''`, `status-format[0] '#[align=centre]#{@caption}'`, `set-titles off`, `allow-rename off`, `allow-set-title off`, `focus-events on` (else Claude Code shows a notice), `default-shell /bin/sh`. The tmux socket is fixed (`cc-demo`). `setUp` kills a server that a crashed run left. Every tmux call uses `-u` for UTF-8. The pane runs `exec env 'PS1=$ ' /bin/sh` in the clone: the non-interactive default shell drops `PS1`, so the command sets it again. No personal shell prompt or rc file shows. Set `TERM=xterm-256color` and `COLORTERM=truecolor`.
4. When recording, start `asciinema rec --headless --window-size <cols>x<rows+1> -f asciicast-v2 -c 'tmux -L <name> attach -t demo' <cast>`. `--headless` works in asciinema 3.2.1.
5. Set the caption to `SYNC-<nonce>`. Write a `sync` event to the timeline. Open a `cut` phase.

### 4.2 Launch

The step `Given a Claude Code session with the artifact-tracking mod` replaces the pane shell with this command (`tmux respawn-pane -k`). Nothing echoes the command line, so its home paths never reach the recording:

```sh
claude --setting-sources project \
  --plugin-dir <repo>/plugins/artifact-tracking \
  --model "$DEMO_MODEL" \
  --append-system-prompt '<one short sentence, no tools>' \
  --settings '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo stop >> <signal>"}]}]}}'
```

A variant step adds a first prompt as the positional argument. The appended system prompt keeps each turn short and tool-free, so no permission dialog opens. The step waits until the prompt box shows (a line that starts with `❯` and white space). If the workspace trust dialog shows, the step presses Down until "Yes, I trust this folder" is selected, then Enter. The whole launch stays in the `cut` phase.

### 4.3 Turn end and slash commands

- A model turn ends when the signal file gains a line. The step reads the line count before it sends Enter, and waits for count + 1.
- A slash command handled by the mod (`/track`) runs no model turn. Its steps wait on screen text instead.

### 4.4 After

1. Write an `end` mark to the timeline. Stop the recorder: detach the tmux client, then wait for asciinema to exit. The retime drops the output after the mark, so the tmux detach screen is not in the GIF.
2. On failure: write `screen.txt` (`capture-pane -p`, ANSI stripped) and keep the cast and timeline.
3. Kill the tmux server. Remove the clone unless `DEMO_KEEP=1`.

## 5. Step vocabulary

The skill reuses these steps first. It adds a step only when no step fits.

| Step | Phase | Action |
| --- | --- | --- |
| `Given a Claude Code session with the artifact-tracking mod` | cut | Launch as in 4.2. |
| `Given a Claude Code session with the artifact-tracking mod and the prompt {string}` | cut, then fast | Launch with a first prompt. Wait for turn end. |
| `When I type {string}` | normal | Type per character, then Enter. |
| `When I press {string}` | normal | One key, for example `Escape`, `r`, `Down`. |
| `When Claude finishes` | fast | Wait for turn end (4.3). |
| `When I wait for {int} seconds` | fast | Wall-clock wait, for example for a refresh. |
| `Then the screen shows {string}` | fast, then normal | Poll until the plain text holds the string. |
| `Then the screen matches {regex}` | fast, then normal | Poll until the regex matches. |
| `Then the screen does not show {string}` | normal | One check, no wait. |
| `Then no permission dialog is open` | normal | Fails when a tool approval dialog shows. |
| `Given the caption {string}` | none | Set `@caption`. |
| `When I pause for {float} seconds` | normal | Hold the frame so a viewer can read it. At most 5 s, the agg idle limit. |

Every wait has a timeout from section 3.3. A timeout fails the step with the last screen in the message.

### 5.1 Example feature

The skill writes the real feature: [`e2e/features/tracking.feature`](../../../e2e/features/tracking.feature). This example only shows the shape.

```gherkin
@demo
Feature: Track what a session mentions

  Scenario: Mention work, see it in the band and the pane
    Given the caption "Mention GitHub work in a prompt"
    And a Claude Code session with the artifact-tracking mod
    When I type "Summarize https://github.com/martin-macak/claude-code-mod-tracking/pull/16 in one line"
    And Claude finishes
    Then the screen matches /tracking .*GitHub 1/
    Given the caption "Open the /track pane for live status"
    When I type "/track"
    Then the screen shows "merged"
    And I pause for 3 seconds
```

## 6. Timeline and retime

### 6.1 Timeline file

`timeline.ndjson` has one JSON object per line. `t` is wall-clock milliseconds from `performance.timeOrigin + performance.now()`.

```json
{"t": 1760000000000, "kind": "sync", "nonce": "SYNC-3f9a"}
{"t": 1760000000500, "kind": "phase", "phase": "cut"}
{"t": 1760000004200, "kind": "phase", "phase": "normal"}
{"t": 1760000006900, "kind": "phase", "phase": "fast"}
```

A phase lasts until the next `phase` event, or until the end of the cast. An `end` event (`{"t": …, "kind": "end"}`) marks the end of the scenario.

### 6.2 Sync

The cast header has a timestamp in whole seconds. That is too coarse. So the retime finds the first output event whose data holds the nonce. Its cast time `c_s` and the timeline `sync` time `T_s` give `offset = c_s − T_s / 1000`. Every phase time becomes `t / 1000 + offset` on the cast clock. No match fails the render.

### 6.3 Retime function

`retime(cast, phases, opts) → cast`. It is pure.

- It builds a piecewise linear map from old cast time to new cast time:
  - `normal`: slope 1.
  - `cut`: length 0. All its events keep their order and get the same new time. So the terminal state stays correct, and no frame from the cut shows.
  - `fast`: length `min(d, opts.fastSeconds)`, default 1.0 s, scaled evenly.
- Events before the sync point fall into the first `cut`.
- Output times never go down.
- Events at or after the `end` mark are dropped.
- Input and output are asciicast v2: absolute times, `[t, "o", data]`. Resize and other event types pass through with mapped times.

Unit tests cover:

- a `normal`-only cast,
- a `cut` at the start,
- a long `fast` phase,
- a short `fast` phase, kept as is,
- a missing sync nonce,
- monotonic output.

### 6.4 Render

`render.ts <cast> <timeline> <out.gif>`:

1. Retime to `session.retimed.cast`.
2. Clean the output text:
   - No-break spaces become spaces, because agg draws them as a stray glyph.
   - Account data is blanked with spaces of the same width: the plan name, usage notices and the reset time zone (`REDACTIONS` in `render.ts`). The match runs over all output joined, because asciinema can split a line over two events.
3. Fail closed: strip escape codes from all output joined, and fail the render when any `LEAKS` pattern still matches (home path, email, plan name, usage, reset time, `Organization`). The message names the text.
4. Run `agg --theme dracula --font-family 'JetBrains Mono,Menlo,DejaVu Sans Mono' --font-size 14 --fps-cap 15 --idle-time-limit 5 --last-frame-duration 4`.
5. Run `gifsicle -O3 --lossy=60 --colors 128` in place.
6. Fail when the file exceeds 2 MB (2 097 152 bytes). The message names the size and the knobs: fewer beats, a lower `--fps-cap`, a higher `--lossy`.

## 7. Make targets

| Target | Does |
| --- | --- |
| `e2e-deps` | `npm ci` in `e2e/` when `package-lock.json` is newer than `node_modules`. |
| `e2e-unit` | `node --test e2e/tests` (no `claude`, no tmux). |
| `e2e` | `e2e-deps`, then `cucumber-js` with the default profile. All scenarios, no recording. |
| `demo` | `e2e-deps`, then `cucumber-js -p demo`, then `render.ts` to `docs/assets/demo.gif`. |
| `typecheck` | Also runs `tsc -p e2e`. |
| `init` | Also reports `tmux`, `asciinema`, `agg` and `gifsicle`. They are needed by `e2e` and `demo` only. |

Node runs through `mise exec node@24`, as for the plugin. The Makefile variable `NODE_RUN` holds that prefix. CI sets it empty: `make test … NODE_RUN=` and `make e2e-unit NODE_RUN=`.

## 8. Repo integration

| File | Change | Reason |
| --- | --- | --- |
| `biome.json` | `files.includes` adds `e2e/**`. | The new TS code gets the same format and lint. |
| `.pre-commit-config.yaml` | The `typecheck` hook matches `^(plugins\|e2e)/`. | `tsc` must see the harness. |
| `.pre-commit-config.yaml` | `check-added-large-files` (512 KB) excludes `^docs/assets/demo\.gif$`. A second entry checks that path at 2048 KB. | Only the demo GIF may be large. |
| `.gitignore` | `e2e/node_modules/`, `e2e/out/`. | Local artifacts. |
| `.github/workflows/test.yml` | Runs `make e2e-unit`. | The retime is pure and cheap to test in CI. |
| `README.md` | New "Demo" section near the top: GIF, short narrative, feature list. | The goal of the pipeline. The skill writes it. |
| `AGENTS.md` | One line: `make e2e` after a change to `plugins/` or `e2e/`, when a Claude login is at hand. | Contributors know the suite exists. |

## 9. The `demo-scenario` skill

Location: `.agents/skills/demo-scenario/SKILL.md`, linked from `.claude/skills/demo-scenario`. That is the same pattern as the other repo skills. Build it with `superpowers:writing-skills`.

Trigger: an agent must make or refresh the demo GIF, write a demo or E2E scenario, or update the README demo section.

Loop:

1. **Learn the features.** Read `plugins/artifact-tracking/README.md` and the specs in `docs/superpowers/specs/`. List the user-visible features. Rank them by how well they show in 30–45 s.
2. **Explore live.** Use `node e2e/bin/drive.ts start | type | key | wait-turn | screen | caption | stop`. It uses its own tmux socket (`cc-demo-drive`) and clone folder (`DEMO_DIR`, default `/tmp/cc-demo-drive`). Try each candidate beat in a real session. Note the exact screen text to assert on. Prefer refs that the mod admits now. Full GitHub URLs are safe. Bare `#N` refs to closed issues may be gated out.
3. **Write the scenario.** Write one `@demo` scenario with 3–4 beats in `e2e/features/`. Give each beat a caption that tells the story. Assert on mod output, not on Claude's words. Use prompts that need no tool approval.
4. **Add steps.** Use the vocabulary in section 5 first. Add a step only when none fits. Keep the phase rules.
5. **Run E2E.** `make e2e` must pass. This is an exit criterion.
6. **Record.** Run `make demo`. Pull 4–6 frames with `ffmpeg -i docs/assets/demo.gif -vf "select=…" frame-%02d.png` into the scratchpad. Read them. Check for:
   - readability,
   - caption sync,
   - no dull stretches,
   - no personal data (home paths, email, account or org names).
7. **Update the README.** Write the "Demo" section: the GIF, a 3–5 sentence narrative that matches the captions, and a feature list.
8. **Clean up.** Delete scratch frames. Commit the feature, steps, GIF and README together.

The skill text does not get markdownlint, because hooks skip `.agents/` and `.claude/`. The skill author checks it by hand.

## 10. Testing

| Layer | What | Where |
| --- | --- | --- |
| Unit | `retime`, cast parse and write, ANSI strip, config parsing. | `make e2e-unit`, local and CI. |
| E2E | All feature files against a real session. | `make e2e`, local only. |
| Demo | The `@demo` scenario recorded and rendered, with a size check. | `make demo`, local only. |

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Live repo data changes, so a step or the GIF goes stale. | Assert on stable text (state words, counts). Re-run the skill when the README GIF looks wrong. |
| A Claude Code release changes the trust dialog, the prompt box or banner text. | The launch step waits on a small set of markers, kept in one place in `session.ts`. |
| The model calls a tool and a permission dialog opens mid-GIF. | Prompts need no tools. `Then no permission dialog is open` fails E2E early. |
| `asciinema rec --headless` behaves differently from the docs. | Checked: it works in 3.2.1. |
| Cucumber cannot load `.ts` with Node type stripping. | Checked: it loads them in 13.3.0. Fallback if that changes: `tsx` as a dev dependency, `--import tsx`. |
| The banner shows account or org data. | The launch stays in a `cut` phase. The skill checks frames for personal data. |
| Two runs at once share the tmux socket, `e2e/out` or `$DEMO_DIR`. | One lock in `<os tmpdir>/cc-demo-lock`, taken before any file is touched, stops a second run. A lock of a dead process is taken over. |
| Claude Code prints new account data. | The render fails closed on `LEAKS`. The frame check in the skill is the second line. Add the pattern to `REDACTIONS`, with a test. |

## 12. Acceptance criteria

1. `make e2e-unit` passes locally and in CI.
2. `make e2e` passes on a machine with a Claude login, `gh` login, tmux, Node 24.
3. `make demo` writes `docs/assets/demo.gif` of at most 2 MB. Its play time is 30–45 s.
4. In the GIF, model waits take about 1 s each. Startup and the trust dialog do not show. Captions change in step with the beats.
5. No frame shows a home path, an email address or an account name.
6. `README.md` shows the GIF, a narrative that matches the captions, and a feature list.
7. The `demo-scenario` skill loads in this repo. An agent that follows it can redo steps 1–7 of section 9 without other guidance.
8. `make lint` passes. The only large-file exception is `docs/assets/demo.gif`.

## 13. Out of scope

- Recording Jira beats. Possible later, if `acli` has a demo site.
- Recording auto-tracking beats that need Claude to make worktrees or agents. They cost more model time and add tool dialogs. The skill may add one if a cheap path exists.
- Hosting the GIF outside the repo.
