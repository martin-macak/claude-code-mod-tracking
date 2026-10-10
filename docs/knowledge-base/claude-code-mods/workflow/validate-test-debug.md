# Validate, test, debug

The check loop for a mod: `validate`, `tsc`, `test`, then a live run with `--debug`. Output below is real, from Claude Code 2.1.295 on this machine, unless marked otherwise.

## The loop

```text
claude plugin validate <mod> [--strict] [--json]   what the engine reads, before any session
tsc -p <mod>                                       types
claude plugin test <mod>                           behaviour, no session, no network
claude --plugin-dir <mod> [--debug]                the real thing
claude -p "/cmd" --plugin-dir <mod>                one command, headless
```

Flags: [cli-help.txt](../sources/claude-code-2.1.295/cli-help.txt). Run `validate` early and often. ([ref:3](../sources/claude-code-2.1.295/reference.md#L3))

## 1. `claude plugin validate`

It reads the manifest and the hooks module's **source** the way the engine will. It runs no code and starts no session. ([docs: create:290](../sources/code-claude-com-2026-10-09/mods/create.md#L290))

Output for the bundled [`tool-call.ts`](../sources/claude-code-2.1.295/examples/tool-call.ts) saved as `hooks/register.ts` (path shortened):

```text
Validating plugin manifest: .../guard/.claude-plugin/plugin.json

⚠ Found 1 warning:
  ❯ author: No author information provided. Consider adding author details for plugin attribution

Validating hooks: .../guard/hooks/hooks.json

  ❯ ./register.ts hooks: tool.call{tool=Edit}, tool.call{tool=Bash}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=Edit}
  ❯ ./register.ts gating hook without .catch: tool.call{tool=Bash}
  ❯ ./register.ts calls: $.ui.status

✔ Validation passed with warnings
```

| Line | Meaning |
| --- | --- |
| `hooks:` | Each event the module hooks, with its matcher in braces. A missing event means the engine will not call that hook either. A misspelled name is an error such as `"tool.calls" is not an event`. ([docs: create:305-307](../sources/code-claude-com-2026-10-09/mods/create.md#L305)) |
| `calls:` | Each `$.noun.method` the code calls. `(via loadNotes)` means `$` was passed to a top-level function of the same file. Also seen: `next.to:append` (the `sec-default` built-in). |
| `gating hook with .catch:` / `without .catch:` | A hook whose answer can refuse something (`tool.call`, `tool.check`, `prompt.submit`, `command.run`, `config.set`, `plugin.register`, a `$` call, others). A fact, not a warning. A gate that fails is skipped unless its `.catch` answers. ([ref:66](../sources/claude-code-2.1.295/reference.md#L66), [ref:78-79](../sources/claude-code-2.1.295/reference.md#L78)) |
| `answers its own command:` | A `command.run` hook that answers a command the module registers by literal name, with no `next`. Not listed as a gate. *(observed on `replay-theater`)* |
| `env reads:` / `env writes:` | Environment variables the module reads or sets. ([docs: admin:126-127](../sources/code-claude-com-2026-10-09/mods/admin.md#L126)) |
| `state reads:` / `state writes:` | The `$.state` keys used. *Not observed here; cited from* [docs: create:305](../sources/code-claude-com-2026-10-09/mods/create.md#L305). |
| `types ./types/index.d.ts declares on $: $.telemetry` | The manifest's contract adds a noun to `$`. *(observed on `telemetry`)* |
| `hooks telemetry for: anthropic, collector` | The telemetry streams the hooks stand on. See below. ([ref:31](../sources/claude-code-2.1.295/reference.md#L31)) |

### Rules the static reader enforces

From [docs: create:309-316](../sources/code-claude-com-2026-10-09/mods/create.md#L309):

- Write each API call in full: `$.store.get('notes')`. Do not alias `$` or a namespace (`const ui = $.ui` fails with `$.ui is used as a value`). Do not destructure `$`.
- You may pass `$` to a **top-level** function of the same file. Passing it to a method, an inner function, or an imported function fails. The `read` and `update` imports of the state library may take it.
- The event name in `on(...)` must be a string literal.
- Do not shadow `on` inside `register`.
- Import only plugin files by relative path. The one bare import is `claude-code`.
- Use `import` declarations, not `import()`, not `require`.

*Observed:* the playground samples follow the rule that `$` goes only to top-level helpers and say so in a comment (`github: anthropics/claude-code-playground@569c528 claude-code/mods/token-weather/hooks/token-weather.mjs`).

### `--strict`

Treats warnings as errors. *Observed:* the run above exits `0` plain and `1` with `--strict`, last line `✘ Validation failed (--strict treats warnings as errors)`. Use it in CI. It catches "unrecognized fields, missing metadata". ([cli-help](../sources/claude-code-2.1.295/cli-help.txt), [docs: cli-reference:626-632](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L626))

| Exit | Verdict |
| --- | --- |
| 0 | passed (with `--strict`: no warnings either) |
| 1 | an error, or a warning under `--strict` |
| 2 | the validator itself failed; nothing on stdout, message on stderr |

### `--json`

One JSON object: `success`, `strict`, `target`, `manifest`, `contents[]`, `advice[]`. *Observed shape:*

```json
{ "success": true, "strict": false, "target": ".../.claude-plugin/plugin.json",
  "manifest": { "type": "plugin", "errors": [], "warnings": [ { "path": "author", "message": "...", "code": null } ],
                "notes": [], "gatingHooks": [] },
  "contents": [ { "file": ".../hooks/hooks.json", "type": "hooks", "errors": [], "warnings": [],
                  "notes": [ "./register.ts hooks: ...", "./register.ts calls: $.ui.status" ],
                  "gatingHooks": [ { "module": "./register.ts", "pattern": "tool.call",
                                     "hook": "tool.call{tool=Edit}", "hasCatch": true } ] } ],
  "advice": [] }
```

- `gatingHooks` is filled under `contents[]` (the `hooks.json` entry). The `manifest.gatingHooks` array was empty. The `hooks:` / `calls:` text sits in `notes[]`.
- Each gating item gives `module`, `pattern`, `hook`, `hasCatch`. ([docs: cli-reference:643](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L643))
- `--json` needs 2.1.259 or later. Same exit codes.

### Marketplace file and README advice

If `.claude-plugin/marketplace.json` sits beside `plugin.json`, one run does three stages: marketplace, plugin, hooks. (2.1.289 and later, [docs: cli-reference](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L612).) *Observed* with a minimal marketplace file:

```text
Validating marketplace manifest: .../.claude-plugin/marketplace.json
⚠ Found 2 warnings:
  ❯ description: No marketplace description provided. ...
  ❯ plugins[0] plugin.json → author: No author information provided. ...
Validating plugin: .../.claude-plugin/plugin.json
...
Validating hooks: .../hooks/hooks.json
...
ℹ Advice (does not change the verdict):
  ❯ .../README.md: This README has no line that installs "guard" from a marketplace. Add the install line, which works in one step on Claude Code 2.1.275 or later. In it, replace <owner>/<repo> with the repository that holds the marketplace.
      /plugin install guard --marketplace <owner>/<repo>
```

- The README advice shows when a `README.md` exists. It does not change the verdict.
- Validating a plugin run does not open the files of plugins a marketplace lists in other directories. Validate each plugin folder. ([docs: cli-reference:624](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L624))

### Telemetry streams: a live failure

*Observed:* the built-in `telemetry` mod (`github: anthropics/claude-code@e47cc82 mods/telemetry`) **fails** `validate` on 2.1.295 when run as a normal plugin:

```text
✘ Found 1 error:
  ❯ modules../register.ts: its hooks stand on the telemetry stream "anthropic" (a matcher names it, or a
    telemetry hook names no "to" and so stands on every stream), which is for the plugins built into the CLI;
    name the collector on each telemetry hook: on("telemetry.log", { to: "collector" }, hook)
```

A third-party telemetry hook must name `{ to: "collector" }`. A bare `telemetry.*` hook counts as standing on every stream. ([ref:31](../sources/claude-code-2.1.295/reference.md#L31)) The GitHub snapshot of the mod predates this rule or is only valid as a built-in. See [../examples/README.md](../examples/README.md#telemetry).

## 2. `tsc -p`

- With the types laid by a session load, `tsc -p <mod>` needs no setup. ([skill:17](../sources/claude-code-2.1.295/SKILL.md#L17))
- Otherwise (first write, `claude -p`, SDK host, installed plugin) use the header's `tsconfig.json`, kept outside the mod folder, with `include` naming the d.ts and the mod's `hooks`. Config: [develop.md](develop.md#types-and-tsconfig).
- `tsc` is not installed on this machine. *Observed:* `npx -y -p typescript@5.6 tsc -p .` exited 0 on the bundled `tool-call.ts` with the d.ts copied by hand into `.claude-plugin/types/claude-code/index.d.ts`.
- TypeScript 5.4 or newer. ([types:8](../sources/claude-code-2.1.295/types/claude-code.d.ts#L8))
- `.jsx` / `.js` modules: use `jsconfig.json` or a `/** @type {import('claude-code').Register} */` comment. ([types:61-66](../sources/claude-code-2.1.295/types/claude-code.d.ts#L61))

## 3. `claude plugin test`

```text
$ claude plugin test .
tests/guard.test.ts:
(pass) denies edits of .env [14.81ms]

 1 pass
 0 fail
Ran 1 test across 1 file. [0.16s]
```

- Runs every `*.test.ts` and `*.test.tsx` under the dir (default: current folder), each file in a child process of the binary. Exits `1` when a test fails. ([cli-help](../sources/claude-code-2.1.295/cli-help.txt))
- Import the kit from `claude-code/testing`: `test`, `expect`, `mock`, `describe`, `tier`. A test gets the engine's own `$` and an `on` whose hooks sit **beneath** the plugin. ([types:29-50](../sources/claude-code-2.1.295/types/claude-code.d.ts#L29))
- Default test time limit: 5 s unless `timeoutMs`. ([docs: reference:294](../sources/code-claude-com-2026-10-09/mods/reference.md#L294))
- No fs, network or process in the test environment. ([types:29-33](../sources/claude-code-2.1.295/types/claude-code.d.ts#L29))
- *Observed:* the test above used `on('tool.call', () => ({ result: 'ok' }))` as the engine's bottom, then `$.tool.call({ tool: 'Edit', ... })`. The mod's deny came back as `out.deny`.
- Trick: run `claude plugin test` in a directory with no mod. `no hooks module to load` means mods can load. `hooks modules are turned off here` means `disableAllHooks` or policy. ([docs: troubleshoot:21-30](../sources/code-claude-com-2026-10-09/mods/troubleshoot.md#L21))

Depth: [../reference/testing-kit.md](../reference/testing-kit.md).

## 4. Live run and debug

| Command | Use |
| --- | --- |
| `claude --plugin-dir <mod>` | Interactive. Watches the folder. Each reload prints one transcript line naming the mod and its hooks. |
| `claude --plugin-dir <mod> --debug-file <path>` | Debug log to a file. Follow with `tail -f <path> \| grep <mod>`. ([docs: troubleshoot:242](../sources/code-claude-com-2026-10-09/mods/troubleshoot.md#L242)) |
| `claude -p "/tally" --plugin-dir <mod>` | One slash command, headless. Prints the command's `text`, for example `first-mod: Claude has made 0 tool calls since this mod loaded`. ([docs: create:208-216](../sources/code-claude-com-2026-10-09/mods/create.md#L208)) |
| `/plugin validate <path>` | Prints the same report as `claude plugin validate`, in a session. ([docs: cli-reference:823](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L823)) |
| `/plugin` → Installed | Shows `N mods active · name`. The line omits built-in mods. ([docs: overview:118](../sources/code-claude-com-2026-10-09/mods/overview.md#L118)) |
| `/reload-plugins` | Reloads installed plugins. Also reloads the broken-save case below. |

*Observed* debug line (via `claude --debug-file`, `claude -p ... --plugin-dir`):

```text
hooks module guard@inline loaded (worker, environment 2, tier user); events: tool.call
```

Same run: `hooks module cc-plugin-sec-default@builtin loaded (native, environment 1, tier prepend)`. The built-in guard loads ahead of user mods when the machine has managed settings or the user is on a Team/Enterprise plan ([docs: admin:58-63](../sources/code-claude-com-2026-10-09/mods/admin.md#L58)). Which condition holds here is unknown.

Where a failure line goes ([ref:79-81](../sources/claude-code-2.1.295/reference.md#L79), [docs: troubleshoot:13-19](../sources/code-claude-com-2026-10-09/mods/troubleshoot.md#L13)):

| Session | Where |
| --- | --- |
| Hot-reloaded folder (`--plugin-dir`, dev-mods once enabled) | One dim transcript line: `<plugin>: <event> hook skipped: ...` or `... refused: <reason>; the engine drew its own` |
| Other interactive session (installed mod) | Debug log only, as `<plugin>: <line>` |
| `claude -p`, text output | stderr, once, for a module not loaded |
| `claude -p`, json / stream-json | Debug log only |

Tips:

- A broken save prints `reload failed, the previous version stays loaded:` plus the reason. The last working version keeps running. ([docs: troubleshoot:264](../sources/code-claude-com-2026-10-09/mods/troubleshoot.md#L264))
- A plugin that "does nothing" has usually been told why: check `validate`, then the debug log. ([ref:81](../sources/claude-code-2.1.295/reference.md#L81))
- `validate` passes but no `hooks:` line: `hooks/hooks.json` has no `modules` key, or it is misspelled. ([docs: troubleshoot](../sources/code-claude-com-2026-10-09/mods/troubleshoot.md#L79))
- Write your own debug line: `$.ui.log('msg', { to: 'debug' })`. Without `to`, it adds a dim transcript line. ([docs: troubleshoot:262](../sources/code-claude-com-2026-10-09/mods/troubleshoot.md#L262))
- A UI tree that fails validation: engine draws its own; debug line starts `ui.render (<Component>): a hook returned a tree that does not validate`. ([skill:51](../sources/claude-code-2.1.295/SKILL.md#L51))

Full message catalog: [../reference/limits-and-diagnostics.md](../reference/limits-and-diagnostics.md).

## See also

- [develop.md](develop.md): layout, loading, reload semantics
- [share-and-admin.md](share-and-admin.md): marketplace file and install line
- [../reference/testing-kit.md](../reference/testing-kit.md)
- [../reference/limits-and-diagnostics.md](../reference/limits-and-diagnostics.md)
- [../examples/README.md](../examples/README.md)
