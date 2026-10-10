# Gotchas

Pitfalls a mod author hits. Read this before you write mod code. Pinned to Claude Code 2.1.295. Each item links to its source or to the KB page with detail.

## Shape and loading

| # | Gotcha | Do this | Source |
| --- | --- | --- | --- |
| 1 | `claude plugin init` does not make a mod. It scaffolds a command-hooks plugin under `~/.claude/skills/`. | Write the three files by hand: `plugin.json`, `hooks/hooks.json`, the hooks module. | [reference.md:9](sources/claude-code-2.1.295/reference.md#L9) |
| 2 | A module that holds `import()` does not load. There is no `require`. Only code suffixes load. | Use static `import` between the mod's own files. | [reference.md:14](sources/claude-code-2.1.295/reference.md#L14) |
| 3 | No Node, no DOM, no `eval`. | Reach files, processes and network through `$.fs`, `$.process`, `$.http`. | [d.ts:14738](sources/claude-code-2.1.295/types/claude-code.d.ts#L14738) |
| 4 | `validate` reads `$` calls statically. `const ui = $.ui` or passing `$` around in odd ways fails validation. | Write `$.noun.method(...)` literally. Pass `$` only to top-level functions in the same file. | [docs: create](sources/code-claude-com-2026-10-09/mods/create.md#L309) |
| 5 | A second `on('x', hook)` with no matcher for the same event makes the module fail to load. | Use one hook per event, or give each a matcher. | [docs: events](sources/code-claude-com-2026-10-09/mods/events.md#L92) |
| 6 | A hook that returns nothing fails. | Always return `next(e)` or an answer. | [d.ts:6535](sources/claude-code-2.1.295/types/claude-code.d.ts#L6535) |
| 7 | `turn.step` and `process.spawn` hooks must be `async function*`. A plain function does not type-check or load. | Use `yield* next(e)` to pass the stream on. | [d.ts:12155](sources/claude-code-2.1.295/types/claude-code.d.ts#L12155) |
| 8 | Telemetry events: `*` and negations select nothing. Third-party hooks need `{ to: 'collector' }`. | Hook each `telemetry.*` event by name with a `to` matcher. | [d.ts:5042](sources/claude-code-2.1.295/types/claude-code.d.ts#L5042), [validate-test-debug](workflow/validate-test-debug.md). `telemetry.mark` has no `to` in the types: [open-questions #6](open-questions.md#source-conflicts) |

## Reload and lifecycle

| # | Gotcha | Do this | Source |
| --- | --- | --- | --- |
| 9 | Only the person answers "Enable hot reloading for this session?". No mode, rule or hook does. If they decline, the mod loads only in the next session. | Ask the person. Or start `claude --plugin-dir <mod>`. | [SKILL.md:19](sources/claude-code-2.1.295/SKILL.md#L19) |
| 10 | A reload runs `register` again and fires `session.start` again. Module variables reset. | Keep values in `$.state` (session) or `$.store` (across sessions). Make `session.start` idempotent. | [SKILL.md:21](sources/claude-code-2.1.295/SKILL.md#L21) |
| 11 | `/clear`, `/resume` and `/branch` reset `$.state`. `session.start` does not fire again after `/clear`. | Restore from `$.store` in `classic.SessionStart` or on first use. | [docs: interface](sources/code-claude-com-2026-10-09/mods/interface.md#L812), [reference.md:27](sources/claude-code-2.1.295/reference.md#L27) |
| 12 | An installed copy is cached by version. Edits to your working copy do not reach it. | Bump `version` and run `claude plugin update`, or use a folder marketplace plus `/reload-plugins`. | [reference.md:76](sources/claude-code-2.1.295/reference.md#L76) |
| 13 | The dev-mods folder is temporary. It is cleaned after `cleanupPeriodDays`. | Copy a finished mod to a folder you keep (this repo). | [docs: create](sources/code-claude-com-2026-10-09/mods/create.md#L55) |

## Guards and dispatch

| # | Gotcha | Do this | Source |
| --- | --- | --- | --- |
| 14 | A hook that throws, times out or answers a wrong shape is skipped. A guard fails **open**. | Add `.catch(($, e, next) => next.called ? next(e) : { deny: 'why' })`. | [d.ts:3936](sources/claude-code-2.1.295/types/claude-code.d.ts#L3936), [dispatch-and-guards](concepts/dispatch-and-guards.md) |
| 15 | A `tool.call` `{ deny }` after `next(e)` undoes nothing. The tool already ran. | Judge before you call `next`. | [d.ts:12701](sources/claude-code-2.1.295/types/claude-code.d.ts#L12701) |
| 16 | The hook budget is 10 s. `$.clock.sleep` counts against it. Waits on `next` and other `$` calls do not. | Start long work from `session.start` with `$.clock.every` / `$.clock.after`. | [d.ts:5100](sources/claude-code-2.1.295/types/claude-code.d.ts#L5100), [reference.md:154](sources/claude-code-2.1.295/reference.md#L154) |
| 17 | `$.fs.stat(path, { resolve: true }).realPath` is absent when the path leads nowhere. A deny-list on spellings is best effort. | Allow-list on `realPath` under a resolved root. Deny on `undefined`. | [d.ts:3321](sources/claude-code-2.1.295/types/claude-code.d.ts#L3321) |
| 18 | `$.mcp.call(server, tool, args)` raises no permission prompt and no `tool.call`. | Treat it as trusted mod code. Do not expect other guards to see it. | [d.ts:2718](sources/claude-code-2.1.295/types/claude-code.d.ts#L2718) |
| 19 | `$.ui.ask` is a `tool.call` of `AskUserQuestion`. Other mods see it. It rejects under `-p` and when dismissed. | Catch the rejection. | [d.ts:2430](sources/claude-code-2.1.295/types/claude-code.d.ts#L2430) |
| 20 | `$.ui.notify` also reaches `classic.Notification` hooks. Two mods that notify on each other's notices loop forever. | Do not notify from a notification hook. | [d.ts:7034](sources/claude-code-2.1.295/types/claude-code.d.ts#L7034) |
| 21 | `$.prompt.submit` queues until the session is idle. It resolves when that turn starts. | Do not await it inside a hook that runs while Claude works. | [reference.md:162](sources/claude-code-2.1.295/reference.md#L162) |

## Conversation rows

| # | Gotcha | Do this | Source |
| --- | --- | --- | --- |
| 22 | `session.append` pins everything except `message.content`. Changing a pinned field fails the hook. | Rewrite `content` only. | [d.ts:10603](sources/claude-code-2.1.295/types/claude-code.d.ts#L10603) |
| 23 | A `session.append` hook cannot refuse an engine row. It can refuse only a plugin's `$.session.append`. | To change what the person typed everywhere, rewrite at `prompt.submit`. | [reference.md:141-145](sources/claude-code-2.1.295/reference.md#L141) |

## Drawing and state

| # | Gotcha | Do this | Source |
| --- | --- | --- | --- |
| 24 | A render hook cannot write `$.state`. | Write from `onPress`, another event, or `update()`. | [d.ts:3416](sources/claude-code-2.1.295/types/claude-code.d.ts#L3416) |
| 25 | State refs need a `const` with literal `plugin` and `key`. Every key must be in the contract `types/index.d.ts`. | `atom({ plugin: 'x', key: 'y' } as const, init)`. | [docs: interface](sources/code-claude-com-2026-10-09/mods/interface.md#L793), [SKILL.md:15](sources/claude-code-2.1.295/SKILL.md#L15) |
| 26 | Elements differ per surface. A table constructor for an element the surface lacks draws an empty fragment, with no error. | Branch on `e.surface`. | [d.ts:3788](sources/claude-code-2.1.295/types/claude-code.d.ts#L3788), [reference/ui](reference/ui.md). Sources disagree: [open-questions #2](open-questions.md#source-conflicts) |
| 27 | A tree that does not validate is not drawn. The engine draws its own. The only sign is a log line. | Run with `claude --debug`. Read [limits-and-diagnostics](reference/limits-and-diagnostics.md). | [reference.md:127](sources/claude-code-2.1.295/reference.md#L127) |
| 28 | A pane opened without a request from the person waits below 144 columns (110 once the person has opened that id). | Check `isPlaced` from `$.ui.open`. Give a command fallback. | [SKILL.md:23](sources/claude-code-2.1.295/SKILL.md#L23), [d.ts:7380](sources/claude-code-2.1.295/types/claude-code.d.ts#L7380) |
| 29 | `focus`, `closeOnEscape`, `holdToasts`, `autoFocus` accept only `true`. `false` throws. | Leave them out instead of `false`. | [docs: interface](sources/code-claude-com-2026-10-09/mods/interface.md#L323) |
| 30 | Some props are read-only (`Pane.placement`, `CommandOutput.command`, ...). Rewriting one fails the hook. | Rewrite only writable props. | [d.ts:10338](sources/claude-code-2.1.295/types/claude-code.d.ts#L10338) |

## Testing

| # | Gotcha | Do this | Source |
| --- | --- | --- | --- |
| 31 | Mounts in one `test()` share the module and `$.state`. A press on one surface leaks into the next. | One `test()` per surface, or reset state. | [testing-kit](reference/testing-kit.md) |
| 32 | The first call on `$` loads the plugins. A later `on(...)` throws. | Register stubs (`on('ui.render', ...)`) before the first `$` call. | [reference/testing-kit](reference/testing-kit.md) |
| 33 | Some public-doc snippets do not type-check on 2.1.295 (`$.turn.complete({ usage: null })`, `$.prompt.submit({ text })`). | Trust the types file. | [d.ts:13324](sources/claude-code-2.1.295/types/claude-code.d.ts#L13324), [d.ts:9051](sources/claude-code-2.1.295/types/claude-code.d.ts#L9051) |
| 34 | Sample mods drift. Playground `token-weather` reads `e.hasSurvey` and `e.bodyColumns`; on 2.1.295 they are under `e.props`. | Check sample code against the types before you copy it. | [d.ts:10259](sources/claude-code-2.1.295/types/claude-code.d.ts#L10259), [examples](examples/README.md) |

## See also

- [concepts/overview](concepts/overview.md), [concepts/dispatch-and-guards](concepts/dispatch-and-guards.md), [concepts/state-and-storage](concepts/state-and-storage.md)
- [reference/limits-and-diagnostics](reference/limits-and-diagnostics.md)
- [open-questions](open-questions.md)
