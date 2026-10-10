# Examples index

Complete mods you can read and copy: three bundled with Claude Code 2.1.295, and seven from GitHub (four built-ins, three playground samples). Event and `$` lists below are **observed** with `claude plugin validate` on 2.1.295, unless marked.

The GitHub sources are a local cache. They are **gitignored** and fetched by [`../sources/fetch-github.sh`](../sources/fetch-github.sh) at pinned SHAs. A link into `../sources/github-cache/` breaks on a fresh clone, so those mods are cited as `github: <repo>@<sha> <path>`:

| Short | Repo | SHA |
| --- | --- | --- |
| `cc` | `anthropics/claude-code` | `e47cc82` |
| `pg` | `anthropics/claude-code-playground` | `569c528` (path under `claude-code/mods/`) |

The public gallery page is a second index: [docs: gallery](../sources/code-claude-com-2026-10-09/mods/gallery.md).

## A. Bundled examples (Claude Code 2.1.295)

Each is one hooks module. With the two JSON files and its contract (if any), it loads, validates and type-checks on 2.1.295. ([skill:31](../sources/claude-code-2.1.295/SKILL.md#L31)) Folder: [`../sources/claude-code-2.1.295/examples/`](../sources/claude-code-2.1.295/examples/).

| File | Shows | Events | `$` calls | Contract |
| --- | --- | --- | --- | --- |
| [tool-call.ts](../sources/claude-code-2.1.295/examples/tool-call.ts) (22 lines) | Deny a tool call; rewrite and observe a call; status line | `tool.call{tool=Edit}`, `tool.call{tool=Bash}` | `$.ui.status` (and `$.plugin.name`, a property read) | none |
| [band.tsx](../sources/claude-code-2.1.295/examples/band.tsx) (61) | A band above the prompt with a Hide button; toast on slow turns | `prompt.submit`, `tool.call`, `turn.complete`, `ui.render{component=AbovePrompt}` | `$.clock.now`, `$.ui.toast`, `$.ui.resolve`; state lib `atom`, `read`, `update` | [band-state.d.ts](../sources/claude-code-2.1.295/examples/band-state.d.ts) |
| [pane.tsx](../sources/claude-code-2.1.295/examples/pane.tsx) (53) | A live pane, opened by a slash command | `session.start`, `command.run{command=tool-calls}`, `tool.call`, `ui.render{component=Pane, requestId}` | `$.command.register`, `$.ui.open`, `$.ui.resolve`; `atom`, `read`, `update` | [pane-state.d.ts](../sources/claude-code-2.1.295/examples/pane-state.d.ts) |

The "From the ask to the shape" table in [SKILL.md](../sources/claude-code-2.1.295/SKILL.md#L29) maps each kind of request to one of these files.

Techniques worth stealing:

- **`tool-call.ts`: guard with `.catch`.** A hook that can refuse gets a `.catch` that refuses too, so a throw does not let the call through. ([ref:79](../sources/claude-code-2.1.295/reference.md#L79))

  ```ts
  on('tool.call', { tool: 'Edit' }, ($, e, next) =>
    PROTECTED.test(e.file_path) ? { deny: `${$.plugin.name}: ${e.file_path} is protected here.` } : next(e),
  ).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
  ```

  *Observed:* `validate` reports `gating hook with .catch: tool.call{tool=Edit}` and `... without .catch: tool.call{tool=Bash}`. The Bash hook awaits `next({ ...e, command: e.command.trim() })`, then acts on the result: observe-after-run.
- **`band.tsx`: yield to the engine.** Return `next(e)` when there is nothing to show or when `e.props.hasSurvey` is true. State lives in `atom`s, written with `update`, read while drawing with `read`, so no `$.ui.invalidate` is needed. ([ref:118](../sources/claude-code-2.1.295/reference.md#L118))
- **`pane.tsx`: size a pane to the viewport.** `Math.max(1, (e.viewport?.rows ?? 24) - 4)` rows. The same `$.ui.open` call runs from `session.start` and from the command, so the command re-opens a closed pane. Both opened with `void` or `await`.

## B. GitHub mods

### Overview

| Mod | Where | Kind | Size (hooks / tests) | Language |
| --- | --- | --- | --- | --- |
| [agents-md](#agents-md) | `cc mods/agents-md` | built-in | 57 files, 1,074 lines / 16 files, 370 | `.ts`, typed `On`/`PluginOptions` |
| [diff](#diff) | `cc mods/diff` | built-in | 591 files, 9,448 lines / 230 files, 7,759 | `.ts`/`.tsx` |
| [sec-default](#sec-default) | `cc mods/sec-default` | built-in | 53 files, 672 lines / 61 files, 1,956 | `.ts` |
| [telemetry](#telemetry) | `cc mods/telemetry` | built-in | 210 files, 3,067 lines / 62 files, 1,952 | `.ts` + `types/index.d.ts` |
| [blast-radius](#blast-radius) | `pg mods/blast-radius` | sample | 1 module (534 lines, with hooks.json) / none | `.mjs` |
| [replay-theater](#replay-theater) | `pg mods/replay-theater` | sample | 1 module (254 lines, with hooks.json) / none | `.mjs` |
| [token-weather](#token-weather) | `pg mods/token-weather` | sample | 1 module (127 lines, with hooks.json) / none | `.mjs` |

Sizes are `wc -l` over `hooks/` and `tests/` in the cache (SHAs above), 2026-10-09; the hooks counts include `hooks.json` and, for `diff`, the whole `hooks/` tree. Source layout of all four built-ins: one `hooks/register.ts` plus one folder per concern with an `index.ts`, and `tests/` with one test file per source file and shared `tests/fixtures/` (one export per file). The playground samples are single `.mjs` files with screenshots and no tests.

- The playground samples have no types file and no tests. The built-ins type `register` with `On` (and `PluginOptions` where they read options), not with `Register`.
- Run any of them from a clone: `claude --plugin-dir mods/diff`. Test: `claude plugin test mods/diff`. ([cc mods/README.md](https://github.com/anthropics/claude-code/tree/e47cc82/mods))
- Built-ins in `/plugin` carry the prefix `cc-plugin-` and the `@builtin` suffix. ([docs: overview:223-232](../sources/code-claude-com-2026-10-09/mods/overview.md#L223))

> **Caution.** The playground samples target an older build. `replay-theater` says "Claude Code 2.1.280 function hooks" in its header. `token-weather` reads `e.hasSurvey` and `e.bodyColumns` from the event top level, but on 2.1.295 both live under `e.props` ([types:10259](../sources/claude-code-2.1.295/types/claude-code.d.ts#L10259), [types:10284](../sources/claude-code-2.1.295/types/claude-code.d.ts#L10284), [ref:117](../sources/claude-code-2.1.295/reference.md#L117), `band.tsx` above). On 2.1.295 that mod never yields to a survey and always uses the 80-column fallback. *(inference from the source; not run in a session)* The types file wins. Copy the technique, check the field names.

### agents-md

- **Purpose.** Loads `AGENTS.md` as project instructions, by one `userConfig` option `instructionFiles`: `claude-md`, `claude-md-or-agents-md` (default), `claude-md-and-agents-md`, `managed-only`. (`github: cc mods/agents-md/README.md`)
- **Observed `hooks:`** `session.start`, `prompt.context{instructionFiles has {kind=?}}`, `prompt.context`, `agent.spawn{fork=true}`, `tool.call{tool=Read}`.
- **Observed `calls:`** `$.env.get`, `$.fs.ancestors`, `$.session.cwd`, `$.session.root`, `$.telemetry.log`, `$.telemetry.mark`, `$.ui.log`. Env reads: `CLAUDE_CODE_DISABLE_ATTACHMENTS`, `CLAUDE_CODE_SIMPLE`, `HOME`, `USERPROFILE`.
- **Notable.** `prompt.context` hands the hook the instruction files (`{ path, kind, content, parent? }`); the hook answers the changed list and the engine renders it as it renders `CLAUDE.md`. `$.fs.ancestors({ names })` walks up from the working directory.
- **Technique: pick hooks at `register` time from `options`.** The module returns early for a mode that needs no hook, and uses an array matcher for the drop:

  ```ts
  if (mode === 'claude-md') return
  if (mode === 'managed-only') {
    on('prompt.context', { instructionFiles: { kind: Files.DROPPED_KINDS } },
      ($, e, next) => next({ ...e, instructionFiles: e.instructionFiles?.filter(Files.isKeptWithoutInstructions) }))
    return
  }
  ```

  (`github: cc mods/agents-md/hooks/register.ts`). Options are fixed per activation; a change reloads the plugin ([types:9294](../sources/claude-code-2.1.295/types/claude-code.d.ts#L9294)), so branching on them once is safe.

### diff

- **Purpose.** `/diff`: the session's uncommitted changes in a pane beside the transcript, refreshed as Claude edits. (`github: cc mods/diff/README.md`)
- **Observed `hooks:`** `session.start`, `ui.render{component=PromptHint}`, `ui.render{component=Pane}`, `command.run{command=diff}`, `ui.close{id}`, `ui.focus{plugin}`, `ui.scroll{requestId}`, `command.run{command=clear|resume}`, `tool.call`, `prompt.submit`. Seven gating hooks, none with a `.catch`.
- **Observed `calls:`** `$.clock.after/every/now`, `$.command.register`, `$.env.get`, `$.fs.list/read/stat`, `$.process.run`, `$.session.id/messages/usage`, `$.settings.read`, `$.store.get/set`, `$.telemetry.log/mark`, `$.ui.close/invalidate/log/open/resolve/status`. Env read: `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`.
- **Notable.** Handles its own wheel scrolling (`ui.scroll`), follows the focus ring (`ui.focus`), runs `git` through `$.process.run`, polls HEAD with `$.clock.every`, keeps the chosen base per repository in `$.store`. Buttons bind engine keybinding actions. Opens the pane unasked only where it would dock (fullscreen, wide enough). Largest example by far; read `hooks/register.ts` (1,035 lines) as the table of contents.
- **Technique: observe a built-in command, then reset.** Call `next(e)` first, then drop session-scoped state when `/clear` or `/resume` has run:

  ```ts
  on('command.run', { command: ['clear', 'resume'] }, async ($, e, next) => {
    const result = await next(e)
    if (!host) return result
    // ... close the pane on resume, reset per-session state
    return result
  })
  ```

  (`github: cc mods/diff/hooks/register.ts`, lines 899-925).

### sec-default

- **Purpose.** The organization security guard. Seated outermost; keeps managed hooks, prompt content, settings and deny rules out of the user tier; adds no policy of its own. Option `allowManagedModsOnly`. See [share-and-admin](../workflow/share-and-admin.md#the-built-in-guard-sec-default). (`github: cc mods/sec-default/README.md`)
- **Observed `hooks:`** `classic.*`, `prompt.section`, `prompt.context`, `prompt.compose`, `skill.prompt`, `attribution.text`, `settings.read`, `tool.describe`, `command.describe`, `agent.offer`, `agent.spawn`, `tool.register`, `tool.list`, `tool.check`, `plugin.register{tier=user}`. `tool.check` and `plugin.register` are gating hooks with a `.catch`; `classic.*`, `settings.read`, `agent.offer`, `agent.spawn`, `tool.register` and `tool.list` are gating hooks without one.
- **Observed `calls:`** `$.settings.read`, `$.ui.log`, `next.to:append`.
- **Notable.** Three moves only: `next.to(e, 'append')` (continue past the user tier), refuse by `next.origin.tier`, or pass. Policy is read with `$.settings.read` and fails closed.
- **Technique: refuse a module by tier, fail closed.**

  ```ts
  on('plugin.register', { tier: 'user' }, async ($, e, next) =>
    Policy.isManagedModsOnly(await $.settings.read(Policy.SOURCE))
      ? { refuse: managedModsOnlyRefusal(e.name) } : next(e),
  ).catch(($, e, next) => {
    $.ui.log(admissionFailure(e.name, next.error), { to: 'debug' })
    return next.called ? next(e) : { refuse: managedModsOnlyRefusal(e.name) }
  })
  ```

  (`github: cc mods/sec-default/hooks/register.ts`, last hook). Also `tool.check`: re-run the chain past the user tier with `next.to` to check a user mod did not loosen a deny rule.

### telemetry

- **Purpose.** Adds `$.telemetry` (`log`, `mark`) for built-in plugins; batches first-party analytics rows; sends nothing where analytics are off. Ships its noun's types in `types/index.d.ts`, named by `"types"` in `plugin.json`. (`github: cc mods/telemetry/README.md`)
- **Observed `hooks:`** `telemetry.*` (with `.catch`; the gate), `telemetry.log`, `telemetry.mark`, `session.start`, `session.end`, `engine.create`.
- **Observed `calls:`** `$.clock.after/sleep`, `$.env.get`, `$.fs.exists/list/read`, `$.http.fetch`, `$.process.run`, `$.session.authorize/cwd/id/model/repo/surfaces/version`, `$.settings.read`, `$.ui.log`. It reads about 50 environment variables (CI, cloud, terminal).
- **Do not use as a template unchanged.** *Observed:* `claude plugin validate` **fails** this mod on 2.1.295 (`its hooks stand on the telemetry stream "anthropic" ... which is for the plugins built into the CLI; name the collector on each telemetry hook`). Details: [validate-test-debug](../workflow/validate-test-debug.md#telemetry-streams-a-live-failure).
- **Technique: add a noun to `$` in `engine.create`.** Wrap what is beneath, spread it last so an existing noun wins:

  ```ts
  on('engine.create', async (_$, e, next) => {
    const beneath = await next(e)
    sender = telemetryOf({ authorize: () => beneath.session.authorize(), /* ... */ })
    const added = { telemetry: sender.telemetry }
    return { ...added, ...beneath }   // what is beneath wins; the noun is added only if absent
  })
  ```

  (`github: cc mods/telemetry/hooks/register.ts`, `engine.create` hook; abridged). The contract lives in `types/index.d.ts` and declares the noun on `EngineInterface`; exported names are led by the noun's PascalCase name. ([types:91-98](../sources/claude-code-2.1.295/types/claude-code.d.ts#L91))

### blast-radius

- **Purpose.** Holds a risky Bash command (`rm -r`, `git reset --hard`, `git clean`, force push, migrations), measures what it would change, and shows Proceed / Cancel in a pane. (`github: pg mods/blast-radius/README.md`)
- **Observed `hooks:`** `tool.call{tool=Bash}` (gating, no `.catch`), `ui.render{component=Pane}`, `ui.render{component=AbovePrompt}`.
- **Observed `calls:`** `$.clock.now`, `$.process.run`, `$.session.cwd`, `$.ui.close/invalidate/open/resolve/toast`.
- **Technique: hold a call for a person.** A hook has about 10 s of its own time, but time inside a `$` call is free, so the hold loops on a short `$.process.run(["sleep", ...])` until a button sets the decision. Stop on `next.signal.aborted`; refuse with a reason the model can act on:

  ```js
  while (mine.decision === null) {
    if (next.signal.aborted) { mine.decision = "interrupted"; break; }
    if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) { mine.decision = "timeout"; break; }
    await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
  }
  ```

  (`github: pg mods/blast-radius/hooks/blast-radius.mjs`). Same sample: `$.ui.open` resolves `{ isPlaced }`; when false it draws the report in the `AbovePrompt` band instead. It passes paths as argv, never through a shell. The held call lives in a module variable, so a reload mid-hold loses it. *(inference)*

### replay-theater

- **Purpose.** `/replay` steps through the file edits Claude made in the last turn, one diff at a time. Never blocks or changes an edit. (`github: pg mods/replay-theater/README.md`)
- **Observed `hooks:`** `session.start`, `command.run{command=replay}` (answers its own command), `tool.call` (gating, no `.catch`), `turn.start`, `turn.complete`, `ui.render{component=AbovePrompt}`, `ui.render{component=Pane}`, `ui.close`.
- **Observed `calls:`** `$.clock.sleep`, `$.command.register`, `$.fs.exists/read`, `$.session.cwd`, `$.ui.close/invalidate/open/resolve`.
- **Technique: record and always pass on.** Collect per turn between `turn.start` and `turn.complete`, skip subagent turns, and never change the event. A failed recording is swallowed, so the edit always runs:

  ```js
  // Record each edit, then let it run. Never blocks the call.
  on("tool.call", async ($, e, next) => {
    if (EDIT_TOOLS.has(e.tool)) {
      try {
        const steps = await stepsFor($, e);
        state.pending.push(...steps);
      } catch { /* recording must never stop the edit */ }
    }
    return next(e);
  });
  ```

  (`github: pg mods/replay-theater/hooks/replay-theater.mjs`). `turn.start` clears `pending` and `turn.complete` promotes it to `replay`, both only `if (!e.agentId)`. Also: a hint above the prompt after the turn, a pane with Prev / Next / Close and hotkeys, an `AbovePrompt` fallback.

### token-weather

- **Purpose.** A one-line forecast of the context window above the prompt: icon, percent, tokens, a block-character chart of the last 12 turns. Smallest sample. (`github: pg mods/token-weather/README.md`)
- **Observed `hooks:`** `session.start`, `turn.complete`, `ui.render{component=AbovePrompt}`.
- **Observed `calls:`** `$.session.usage (via takeReading)`, `$.ui.invalidate (via takeReading)`, `$.ui.resolve`.
- **Technique: free, real numbers.** `$.session.usage()` returns `context: { tokens, window, percent }` with no token-count request. Wrap the read in `try/catch`, then `$.ui.invalidate("ui.render")`; skip subagent turns with `if (e.agentId) return result`. Helpers that take `$` are top-level functions, which `validate` needs.

  ```js
  async function takeReading($) {
    try {
      const { context } = await $.session.usage();
      if (!context || !context.window) return;
      // ... push { tokens, window, percent } to readings
      $.ui.invalidate("ui.render");
    } catch { /* keep the last reading */ }
  }
  ```

  (`github: pg mods/token-weather/hooks/token-weather.mjs`). Module variable `readings` resets on reload. Stale field names: see the caution above. It draws with `Box({...})` / `Text({...})` function calls instead of JSX, which also works in a `.mjs` module.

## Choosing one to start from

| You want to | Start from |
| --- | --- |
| Deny or rewrite tool calls | `tool-call.ts`, then `blast-radius` |
| A band above the prompt | `band.tsx`, then `token-weather` |
| A pane and a command | `pane.tsx`, then `replay-theater`, then `diff` |
| Options from `userConfig` | `agents-md` |
| Org policy / refuse other mods | `sec-default`, plus [share-and-admin](../workflow/share-and-admin.md) |
| A new noun on `$` | `telemetry` (types file and `engine.create`) |
| Tests | any built-in `tests/`; see [../reference/testing-kit.md](../reference/testing-kit.md) |

## See also

- [../workflow/develop.md](../workflow/develop.md): load and reload a mod
- [../workflow/validate-test-debug.md](../workflow/validate-test-debug.md): the `validate` output used above
- [../workflow/share-and-admin.md](../workflow/share-and-admin.md): the guard and the marketplace file
- [../reference/events.md](../reference/events.md), [../reference/ui.md](../reference/ui.md), [../reference/engine-interface.md](../reference/engine-interface.md)
- [../concepts/overview.md](../concepts/overview.md)
