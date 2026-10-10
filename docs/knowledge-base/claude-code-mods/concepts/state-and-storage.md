# State and storage

Where a mod keeps a value, how long it lives, and how a drawing reads it. Covers module variables, `$.state`, `$.store`, the type contract and the state library.

## Three places for a value

| Place | Lives until | Shared across sessions | Redraws readers | Use for |
| --- | --- | --- | --- | --- |
| Module variable (`let n = 0`) | The module reloads. Every saved file reloads it in development. | No | No (call `$.ui.invalidate`) | Values you can lose |
| `$.state` | The session ends, or the person runs `/clear`, `/resume`, `/branch`. **Survives a hot reload.** | No | **Yes**, automatic | Values a drawing reads |
| `$.store` | You delete it, or no session reads or writes the store for `cleanupPeriodDays` | Yes, per plugin, per machine | No | Settings, history, anything to find next time |

Sources: [docs: interface, "Keep state"](../sources/code-claude-com-2026-10-09/mods/interface.md#L724), [reference.md:118](../sources/claude-code-2.1.295/reference.md#L118), [SKILL.md:21](../sources/claude-code-2.1.295/SKILL.md#L21).

A reload runs `register` again. Module variables start over. `$.state` and `$.store` are the host's and stay. ([SKILL.md:21](../sources/claude-code-2.1.295/SKILL.md#L21))

## `$.state`

Named values the host holds for the session, each with a **version**. Plain JSON data. ([d.ts:3376](../sources/claude-code-2.1.295/types/claude-code.d.ts#L3376))

| Call | Result | Rules |
| --- | --- | --- |
| `$.state.get(ref)` | `{ value, version }`. A value never written is `undefined` at version 0. | All `get`s of one dispatch read one moment. Any plugin may read any value. A `get` made while a `ui.render` hook draws **subscribes** that instance. |
| `$.state.set(ref, value, { ifVersion? })` | `{ isSet, version }`. `isSet: false` only when `ifVersion` missed. | Refused while a `ui.render` hook draws. Refused for another plugin's value. `value` is JSON, never `undefined`. With `ifVersion` it is compare-and-set. The version rises by one per landed write. |

Sources: [d.ts:3376-3430](../sources/claude-code-2.1.295/types/claude-code.d.ts#L3376), [d.ts:12038](../sources/claude-code-2.1.295/types/claude-code.d.ts#L12038) (`StateRead`), [d.ts:12072](../sources/claude-code-2.1.295/types/claude-code.d.ts#L12072) (`StateSetOptions`).

Rules to keep:

- **Render hooks never write.** Write from a handler (`onPress`, `onSubmit`) or from a hook for another event. ([reference.md:118](../sources/claude-code-2.1.295/reference.md#L118), [docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L795))
- **Never write from a value the closure captured at draw time.** Use `update`. It reads, applies and writes with `ifVersion`, again on a miss. Two presses before the redraw both land. ([reference.md:118](../sources/claude-code-2.1.295/reference.md#L118))
- **Only the owner writes.** Another plugin changes a value by hooking `state.set` with a matcher on `plugin` and `key`, and passing `next` another `value`. `plugin`, `key` and `id` are pinned. ([reference.md:118](../sources/claude-code-2.1.295/reference.md#L118), [d.ts:12060](../sources/claude-code-2.1.295/types/claude-code.d.ts#L12060))

  ```ts
  on('state.set', { plugin: 'swarm', key: 'isOn' }, ($, e, next) => next({ ...e, value: false }))
  ```

- `state.get` and `state.set` are events like every `$` call. On the untyped form (no contract declares the value), a hook sees `e.previous` (what stood there), put on `e` ahead of every hook. ([d.ts:7113](../sources/claude-code-2.1.295/types/claude-code.d.ts#L7113), [d.ts:12104](../sources/claude-code-2.1.295/types/claude-code.d.ts#L12104))
- **Redraw is automatic and throttled.** A `set` draws exactly the readers again. Nobody calls `$.ui.invalidate`. Redraws are throttled to 10 a second, 30 in the terminal for the shown pane, expanded band and prompt hint. ([docs: reference, Limits](../sources/code-claude-com-2026-10-09/mods/reference.md#L290))
- **`/clear`, `/resume`, `/branch` reset every `$.state` value** to its default. `session.start` does not fire again. `classic.SessionStart` fires with `e.source` of `clear`, `resume` or `fork`. A mod that copies a stored value into `$.state` must copy it again there. The same hook also fires at startup and after compaction (compaction does not reset state), so filter on `source`. ([docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L812))

  ```ts
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await loadCount($)        // copy $.store -> $.state again
    return next(e)
  })
  ```

### The redraw loop

```mermaid
sequenceDiagram
    participant U as Person
    participant H as Handler (onPress closure)
    participant S as $.state (host, versioned)
    participant R as ui.render hook
    participant X as Surface

    X->>R: draw Pane / AbovePrompt
    R->>S: read($, count) via $.state.get
    S-->>R: { value, version }
    Note over S,R: the read subscribes this instance
    R-->>X: tree
    U->>H: press Button
    H->>S: update($, count, n => n + 1)
    S-->>H: get, then set with ifVersion (retry on a miss)
    Note over S: a landed write bumps the version
    S->>R: redraw subscribed readers only
    R->>S: read again
    R-->>X: new tree
```

## The type contract

A mod that uses `$.state` declares each value in a **contract**: one `.d.ts` file. ([SKILL.md:15](../sources/claude-code-2.1.295/SKILL.md#L15), [docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L742))

1. Write `types/index.d.ts`. Merge into `PluginState` inside `declare module 'claude-code'`. The outer key is the plugin's **name**. Each entry under it is a value and its type. ([d.ts:7786](../sources/claude-code-2.1.295/types/claude-code.d.ts#L7786))
2. Name the file in `plugin.json`: `"types": "./types/index.d.ts"`.
3. The module imports its value types from it: `import type { Turn } from '../types'`.
4. `claude plugin validate` holds every `$.state` key the module names to the contract. A key that is not declared fails: `hello-tabs.count is not declared`. ([SKILL.md:15](../sources/claude-code-2.1.295/SKILL.md#L15), [docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L793))

Contracts from the shipped examples:

```ts
// examples/band-state.d.ts  ->  types/index.d.ts of the band mod
export type Turn = { seconds: number; tools: number }

declare module 'claude-code' {
  interface PluginState {
    'turn-band': { last: Turn | null; isHidden: boolean }
  }
}
```

```ts
// examples/pane-state.d.ts  ->  types/index.d.ts of the pane mod
export type ToolCall = { id: string; tool: string; isDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    'tool-calls': { calls: ToolCall[] }
  }
}
```

Sources: [band-state.d.ts](../sources/claude-code-2.1.295/examples/band-state.d.ts), [pane-state.d.ts](../sources/claude-code-2.1.295/examples/pane-state.d.ts).

The same `"types"` field serves a second purpose. A plugin that **adds a noun to `$`** in `engine.create` ships that noun's types as a contract: a self-contained `.d.ts` that exports the noun's types at top level (names led by the noun's PascalCase name) and adds the noun to `EngineInterface`. A plugin that depends on it lists it under `dependencies`, and the engine lays the contract in beside it. `claude plugin validate` checks the contract. ([reference.md:66](../sources/claude-code-2.1.295/reference.md#L66))

## References

A reference names one value. Write it once as a constant. ([reference.md:118](../sources/claude-code-2.1.295/reference.md#L118), [d.ts:12054](../sources/claude-code-2.1.295/types/claude-code.d.ts#L12054))

```ts
const count = { plugin: 'counter', key: 'count' } as const
const { value = 0 } = await $.state.get(count)
```

- `plugin` and `key` must be **string literals in source**. `claude plugin validate` reads them and lists `state reads:` and `state writes:`. ([d.ts:3376](../sources/claude-code-2.1.295/types/claude-code.d.ts#L3376), [docs: create](../sources/code-claude-com-2026-10-09/mods/create.md#L305))
- Only a `StateFamily` member's `id` may be computed.
- Use the const for nothing but `$.state` calls, state library calls, and a spread that adds a family member's `id`.
- Hold an `atom` result in a `const`. A `let` fails validation with `takes a source the scan can read`. ([docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L793))

## The state library

Import from `claude-code`. These are pure and run in the plugin's environment. They call `$.state.get` and `$.state.set` for you. ([d.ts:14690-14735](../sources/claude-code-2.1.295/types/claude-code.d.ts#L14690))

| Export | Does | Notes |
| --- | --- | --- |
| `atom(ref, initial)` | Names a value with an initial. A `read` is never `undefined`. | Pure. Builds a frozen description. For a family, give the ref without `id`. `atom(ref, initial, { shape })` tags the value ([d.ts:688](../sources/claude-code-2.1.295/types/claude-code.d.ts#L688), [d.ts:720](../sources/claude-code-2.1.295/types/claude-code.d.ts#L720)). |
| `read($, source)` | Reads an atom, a derived value or a reference. | While a `ui.render` hook draws, it subscribes. |
| `update($, target, fn)` | Reads, applies `fn`, writes with `ifVersion`, retries on a miss. | Resolves what it wrote. Use it in handlers. |
| `derive(sources, fn)` | A value computed from atoms and references. | Cached by source versions. The cache is plugin-side and lost on reload. |
| `memberOf(family, e)` | A family's member for the instance being drawn, keyed by `e.requestId`. | Pairs with `StateFamily`. |

Types:

| Type | Meaning | Line |
| --- | --- | --- |
| `StateFamily<T>` | A key that holds one value of type `T` per `id` (one per drawn row). Its reference needs `id`. `interface PluginState { notes: { isOpen: StateFamily<boolean> } }` | [d.ts:12009](../sources/claude-code-2.1.295/types/claude-code.d.ts#L12009) |
| `Shaped<T>` | `{ shape, value }`. Declare a key as `Shaped<T>` when its atom names a shape. A reload whose code names another shape reads the value as absent. Bump the shape when the code's idea of the value changes. | [d.ts:11833](../sources/claude-code-2.1.295/types/claude-code.d.ts#L11833) |
| `StateRef`, `StateName`, `StateValue`, `StateRead`, `StateSetResult` | Reference, name, value and result types | [d.ts:12054](../sources/claude-code-2.1.295/types/claude-code.d.ts#L12054) |

```ts
import { atom, derive, memberOf, read, update } from 'claude-code'

const isOpen = atom({ plugin: 'notes', key: 'isOpen' } as const, false)  // family: ref has no id
// in a ui.render hook:
const open = await read($, memberOf(isOpen, e))   // keyed by e.requestId
```

## Worked examples

### Band: module variables plus `$.state`

[examples/band.tsx](../sources/claude-code-2.1.295/examples/band.tsx) keeps what the drawing needs in `$.state` and what it can lose in variables.

```tsx
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Turn } from '../types'

const last = atom({ plugin: 'turn-band', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'turn-band', key: 'isHidden' } as const, false)

export const register: Register = on => {
  let startedAt = 0      // module variables: lost on reload
  let tools = 0

  on('prompt.submit', async ($, e, next) => { startedAt = await $.clock.now(); tools = 0; return next(e) })
  on('tool.call', ($, e, next) => { tools += 1; return next(e) })
  on('turn.complete', async ($, e, next) => {
    const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
    await update($, last, () => ({ seconds, tools }))        // write from another event
    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const turn = await read($, last)                          // subscribes the band
    if (turn === null || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return <Box>
      <Text dimColor>Last turn: {turn.seconds}s, {turn.tools} tool calls </Text>
      <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
    </Box>
  })
}
```

(Excerpt, trimmed. The toast and `hasSurvey` check are in the file.)

What to notice:

- `last` and `isHidden` are declared in the contract above and read in the render hook.
- `onPress` writes with `update`, so the band redraws without `$.ui.invalidate`.
- `startedAt` and `tools` are plain variables. *Inference:* a reload in the middle of a turn resets `startedAt` to 0, so the next `seconds` would be huge. Keep such values in `$.state` if that matters.

### Pane: a list in `$.state`

[examples/pane.tsx](../sources/claude-code-2.1.295/examples/pane.tsx) keeps the whole list in `$.state`.

```tsx
const calls = atom({ plugin: 'tool-calls', key: 'calls' } as const, [])

on('tool.call', async ($, e, next) => {
  const call = { id: e.tool_use_id, tool: e.tool, isDone: false }
  await update($, calls, list => [...list, call].slice(-200))        // bound the list
  const ran = await next(e)
  await update($, calls, list => list.map(one => (one.id === call.id ? { ...one, isDone: true } : one)))
  return ran
})

on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
  const list = await read($, calls)                                   // subscribes the pane
  ...
})
```

What to notice: both `update` calls run in the `tool.call` hook, not in the render hook. The list is capped at 200. The pane id (`requestId`) is the id given to `$.ui.open`.

## `$.store`: across sessions

A key-value store of the plugin's own, kept between sessions and hot reloads. ([d.ts:3350-3376](../sources/claude-code-2.1.295/types/claude-code.d.ts#L3350))

| Call | Behaviour |
| --- | --- |
| `$.store.get(key)` | The value, or `undefined` |
| `$.store.set(key, value)` | `value` must be JSON. `get` reads back `JSON.parse(JSON.stringify(value))`: a `Date` becomes an ISO string, `undefined` fields drop, `Map` and `Set` become `{}`. Rejects a function, a cycle, or a store over **4 MiB** of JSON text in all. |
| `$.store.delete(key)` | Removes the key |
| `$.store.keys()` | Every key, in insertion order |

- The file is JSON, in the user's Claude Code config directory ([d.ts:3350](../sources/claude-code-2.1.295/types/claude-code.d.ts#L3350)). Public docs name `~/.claude/plugins/store/` ([docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L732)). The dev-mods folder follows the config directory too (SKILL.md shows `~/.claude-personal/dev-mods/<session-id>`; the public docs show `~/.claude/dev-mods/<session-id>`).
- **Every session on the machine shares one store.** `get` then `set` is not atomic. Two sessions can race and the second write wins. Give each item its own key, and read again right before you write. ([docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L842))
- `$.store.set` is an event too (`store.set`). ([d.ts:7095](../sources/claude-code-2.1.295/types/claude-code.d.ts#L7095))
- To keep a `$.state` value past the session, also write it to `$.store`. Save on every change. ([reference.md:118](../sources/claude-code-2.1.295/reference.md#L118), [docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L838))

## What survives what

| | Reload (`register` again) | Worker loss | `/clear`, `/resume`, `/branch` | New session |
| --- | --- | --- | --- | --- |
| Module variable | Lost | Lost | Kept (same module) | Lost |
| Timers (`$.clock`) | Dropped | Gone | Kept | Gone |
| `$.state` | **Kept** | Kept (host holds it) | **Reset to default** | Gone |
| `$.store` | Kept | Kept | Kept | Kept |
| Open panes (`$.ui.panes()`) | Kept (engine's record) | n/a | n/a | Gone |

Sources: [reference.md:72](../sources/claude-code-2.1.295/reference.md#L72), [reference.md:162](../sources/claude-code-2.1.295/reference.md#L162), [d.ts:2527](../sources/claude-code-2.1.295/types/claude-code.d.ts#L2527), [docs: interface](../sources/code-claude-com-2026-10-09/mods/interface.md#L812). The worker-loss and `/clear` module-variable cells are *inference* from the cited text.

## See also

- [overview](overview.md): the mental model.
- [dispatch-and-guards](dispatch-and-guards.md): reload and worker-loss replay of calls.
- [glossary](glossary.md): terms.
- [reference/ui](../reference/ui.md): `ui.render`, panes, bands.
- [reference/testing-kit](../reference/testing-kit.md): `mock.store` and state tests.
- [examples/README](../examples/README.md).
