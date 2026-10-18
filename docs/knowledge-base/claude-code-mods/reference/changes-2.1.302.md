# Changes in 2.1.302

What changed between the pinned snapshot **2.1.295** and **2.1.302**, as far as a mod author needs to know. Method: `diff` of the two snapshots in [`sources/`](../sources/README.md), then a check of each change that matters against the code. Anchors point to the [2.1.302 types](../sources/claude-code-2.1.302/types/claude-code.d.ts) unless a line says otherwise.

Grades on a claim:

- *types-only*: the d.ts or `reference.md` says it. Nobody ran it.
- *verified-kit*: seen in `claude plugin validate` or `claude plugin test`.
- *verified-live*: seen in a real interactive session.
- *inference*: no source says it.

Rows in "Behaviour changes that can break a mod" and "New API" are *types-only* (read from the d.ts or `reference.md`) unless the row marks another grade. The "Unchanged" rows name the check in their last column. "Observed, not in the types" states its grade in its first line and marks any other.

## Size of the change

- The types file grew from 21,451 to 22,255 lines. The first line reads `// Written by Claude Code 2.1.302.` ([d.ts:1](../sources/claude-code-2.1.302/types/claude-code.d.ts#L1))
- The diff has 206 hunks and 1,240 changed lines (1,022 added, 218 removed). 153 hunks are in the engine API, mostly reworded doc comments. 53 are in the tool schemas appended after it (Artifact, Read, Cron: `owned`, `editsApplied`, `allow_large`, `nextFireAt`), from [d.ts:16704](../sources/claude-code-2.1.302/types/claude-code.d.ts#L16704), where the second `declare module 'claude-code'` (the tool inputs) starts. The first one starts at line 101.
- No removal of a documented call. One **name** was removed: the `re-entry` failure kind and the `lent` cause. The behaviour it named stays: a hook is not run beneath its own call (see [Observed, not in the types](#observed-not-in-the-types)). One rule was relaxed in the validator (same section).

## Unchanged

| Area | How it was checked |
| --- | --- |
| `claude plugin` CLI: `configure details disable enable eval init install list marketplace prune tag test uninstall update validate` | `cli-help.txt` is byte-identical. |
| The three bundled examples and two state contracts | `diff -r` of `examples/` shows nothing. |
| `$.fs`, `$.store`, `$.state` | The block is byte-identical: 2.1.295 lines 3223-3397 equal 2.1.302 lines [3306-3480](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3306). |
| `PluginOptions`, `userConfig`, `register(on, options)` | Same type at [d.ts:7822](../sources/claude-code-2.1.302/types/claude-code.d.ts#L7822) and [d.ts:9713](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9713). |
| `claude-code/testing` | One type changed: `EngineNoun` takes the call-input type for `skill.prompt` ([d.ts:15811](../sources/claude-code-2.1.302/types/claude-code.d.ts#L15811)). `mock` still has `clock`, `store`, `env`, `session` only. |
| Button `hotkey` and `action`, Pane and AbovePrompt props, `Client` `onKey`, `$.ui.focus`, `autoFocus` | No hunk touches them. Only the `no-surface` wording changed (below). |
| Session lifecycle: `session.start`, `session.end`, `SessionEndInput`, the 1.5 s bound | No hunk. See [lifecycle](../concepts/lifecycle.md). |

## Behaviour changes that can break a mod

| Area | Change | Anchor | What to do |
| --- | --- | --- | --- |
| `turn.start` | Fires for a subagent's or teammate's run too. New `agentId?` on `TurnStartInput` (absent on the main loop). In 2.1.295 a subagent's run raised no `turn.start`. The hooks an agent's spawn is nested in do not hear its start. | [d.ts:4554](../sources/claude-code-2.1.302/types/claude-code.d.ts#L4554), [d.ts:14045](../sources/claude-code-2.1.302/types/claude-code.d.ts#L14045), [d.ts:14060](../sources/claude-code-2.1.302/types/claude-code.d.ts#L14060) | Return `next(e)` first when `e.agentId !== undefined` to follow the main loop alone. `$.turn.abort` and its `turnId` also say "the main loop's" now ([d.ts:2988](../sources/claude-code-2.1.302/types/claude-code.d.ts#L2988)). |
| `turn.complete` | Every hook hears an agent's end, the spawner's too. A hook that heard a turn's start hears its end after it. One that heard no start hears the end alone. | [d.ts:4579](../sources/claude-code-2.1.302/types/claude-code.d.ts#L4579), [d.ts:13959](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13959) | A hook that spawns at each end sees its children's ends and must bound itself. |
| `agent.spawn` | New `resume: { agentId }` for a resumed subagent or a teammate brought back from disk. A hook can only refuse it. A deny parks the agent. For a workflow agent a rewrite of `prompt` and `model` now applies. A deny is the error the script's `agent()` throws. | [d.ts:380](../sources/claude-code-2.1.302/types/claude-code.d.ts#L380), [d.ts:349](../sources/claude-code-2.1.302/types/claude-code.d.ts#L349) | Key a per-agent row by `agentId`. A resumed agent is not a new agent. |
| `HookFailure` | `kind` is `'throw' \| 'timeout'`. `'re-entry'` and `cause: 'lent'` are gone. The `CatchHandler` doc no longer says "asked for `re-entry`, its own `$` calls reject". The skip itself stays (next row). | [d.ts:5277](../sources/claude-code-2.1.302/types/claude-code.d.ts#L5277), [d.ts:1202](../sources/claude-code-2.1.302/types/claude-code.d.ts#L1202) | The guard form `.catch(($, e, next) => next.called ? next(e) : { deny })` is unchanged. Do not branch on `'re-entry'`. |
| A hook run again beneath its own call | New rule for the nouns a plugin adds to `$` (`PluginNoun`: never `tool`, `session` or `ui`). It applies to a hook with no `.catch` that the engine runs again beneath its own call to such a noun. If that hook makes the same call again for the same event, the third identical open call waits behind the second. It ends with the second if the second goes unanswered. *Not tested.* For the engine nouns the calling hook is skipped, not run again: see [Observed](#observed-not-in-the-types). | [d.ts:7804](../sources/claude-code-2.1.302/types/claude-code.d.ts#L7804) | Make hooks idempotent. Keep a `.catch((_$, e, next) => next(e))` on observe-only hooks. |
| Hot reload | A save that leaves a loaded file holding the text it was loaded from reloads nothing. After a failed reload any new save tries again. | [reference.md:73](../sources/claude-code-2.1.302/reference.md#L73) | Formatter runs and no-op saves no longer fire `register` and `session.start`. *verified-live:* an identical `cp` kept the same module copy. |
| `$.ui.open`, `ui.focus`, `ui.scroll` | A result may start with `no-surface` when no surface is attached (a `-p` run). `isPlaced: false` also covers "none attached". `$.ui.panes()` shows no row shown or focused while an open answers `no-surface`. | [d.ts:14829](../sources/claude-code-2.1.302/types/claude-code.d.ts#L14829), [d.ts:14612](../sources/claude-code-2.1.302/types/claude-code.d.ts#L14612), [d.ts:15105](../sources/claude-code-2.1.302/types/claude-code.d.ts#L15105) | Do not read `isPlaced: false` as "terminal too narrow". Read `reason`. |
| `session.append` | New door `queue`: the text of a message-queue record (a prompt's or a machine-made one's), raised as a user row the conversation never keeps. A hook there that throws or takes over a second is passed by ([reference.md:168](../sources/claude-code-2.1.302/reference.md#L168)). | [d.ts:10978](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10978), [d.ts:10984](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10984) | A hook on named doors is not affected. A `*` hook or one with no `door` matcher now sees queue text. |
| `prompt.submit` | Input gains `command: { name, args }` and `isMeta`. Both are pinned. A rewrite of `text` is not applied when `command` is set. `PromptSubmitArgs` omits both. `text` is now "as typed, pastes expanded". | [d.ts:9421](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9421), [d.ts:9444](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9444) | Mask a slash command's arguments at `command.run`, not at `prompt.submit`. |
| `$.env.set` | Resolves `EnvSetResult` (`{ deny? }`), not `void`. Under organization settings the engine may hold a write. | [d.ts:3693](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3693), [d.ts:4824](../sources/claude-code-2.1.302/types/claude-code.d.ts#L4824) | Read the result. |
| `tool.check` | Result gains `setting` and `decider: 'host'`. In plan mode a hook only tightens a call not shown to be a read. | [d.ts:13533](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13533), [d.ts:13441](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13441) | None, unless you match on the verdict's shape. |
| `$.command.run`, `$.mcp.connect` | `$.command.run` also rejects "past a Stop or a host's limit". `$.mcp.connect` is a no-op for a server the manifest lists, since a listed server joins at session start. | [d.ts:3152](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3152), [d.ts:2770](../sources/claude-code-2.1.302/types/claude-code.d.ts#L2770) | Wrap `$.command.run` in `try`/`catch`. To hold a listed server's tools back, refuse their calls at `tool.check`. |

## New API

| Area | What is new | Anchor |
| --- | --- | --- |
| `$.ui.view({ agentId })` | Puts an agent's transcript in the main view. `{}` goes back. It works only while the call answers the person's own input (a press, a pick, a typed prompt or command). Result `{}` or `{ deny }`. New event `ui.view`. A Pane or AbovePrompt reads the view as `e.props.view`. | [d.ts:2620](../sources/claude-code-2.1.302/types/claude-code.d.ts#L2620), [d.ts:15221](../sources/claude-code-2.1.302/types/claude-code.d.ts#L15221), [d.ts:7183](../sources/claude-code-2.1.302/types/claude-code.d.ts#L7183) |
| `prompt.change` | New observe-only event. Input `{ text, cursor, origin }`. `origin.kind` is `history`, `clear`, `undo`, `plugin` (with `name`), `app` or `engine`. Treat an unknown kind as `engine`. | [d.ts:4239](../sources/claude-code-2.1.302/types/claude-code.d.ts#L4239), [d.ts:8482](../sources/claude-code-2.1.302/types/claude-code.d.ts#L8482), [d.ts:8509](../sources/claude-code-2.1.302/types/claude-code.d.ts#L8509) |
| Box spacing | `gap`, `columnGap`, `rowGap`, `margin*` and `padding*` take `Space = number \| 'xs' \| 'sm' \| 'md' \| 'lg' \| 'xl'`. A number means cells on every surface. A step name differs per surface: on the terminal across `xs` and `sm` 1, `md` 2, `lg` 3, `xl` 4 cells, and down 0, 0, 1, 1, 2. Use numbers for column math. | [d.ts:990](../sources/claude-code-2.1.302/types/claude-code.d.ts#L990), [d.ts:12508](../sources/claude-code-2.1.302/types/claude-code.d.ts#L12508) |
| `Text` props | `size`, `weight` (`regular` `medium` `semibold` `bold`), `mono`, `tabular`, `dir`. `bold` is deprecated and reads as `weight: 'semibold'`. The terminal ignores `size`, `mono` and `tabular` (*types-only*). For `dir` the d.ts says only that a terminal that reorders text itself draws the `Text` as without `dir`. Whether Claude Code's terminal ignores `dir` is not stated (*inference*: no effect). The terminal draws `semibold` and `bold` as bold. | [d.ts:13173](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13173) |
| `Input` `rows` | `rows` of 2 or more makes a multi-line field. Enter still submits. Up and Down walk the rows, then leave the field. The text is whole, lines joined by `\n`. | [d.ts:5621](../sources/claude-code-2.1.302/types/claude-code.d.ts#L5621), [d.ts:9913](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9913) |
| `Elements`, `RenderSurface` | `Elements` is an `interface`, and `RenderSurface` is `keyof Elements & string`. A new surface table can be added by declaration merging. An element a surface does not know renders as a fragment. The tables are as before: no Tree, Table or DataTable element exists on any surface. | [d.ts:3891](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3891), [d.ts:10803](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10803) |
| `agent.spawn` spec | New key `autoCompactWindow` (100000 to 1000000): the token count at which the agent compacts its own conversation. | [d.ts:522](../sources/claude-code-2.1.302/types/claude-code.d.ts#L522) |
| `skill.prompt` | Input gains `frontmatter`, `frontmatterProblem`, `source` (`SkillSource`), `pluginName`, `path`. A call may leave `frontmatter` and `source` out. | [d.ts:12424](../sources/claude-code-2.1.302/types/claude-code.d.ts#L12424), [d.ts:12480](../sources/claude-code-2.1.302/types/claude-code.d.ts#L12480) |
| Managed-only calls | `$.session.identity()` and `$.prompt.media({ id })` answer a mod that managed settings install. Any other mod gets `{ deny }`. | [d.ts:2981](../sources/claude-code-2.1.302/types/claude-code.d.ts#L2981), [d.ts:3043](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3043) |
| `ui.render` tree | A returned root carries `part`, the plugin whose drawing starts there. It proves no author. | [d.ts:12816](../sources/claude-code-2.1.302/types/claude-code.d.ts#L12816) |

## Docs and skill text

- [reference.md:73](../sources/claude-code-2.1.302/reference.md#L73): the identical-save rule.
- [reference.md:79](../sources/claude-code-2.1.302/reference.md#L79): the long `.catch` paragraph loses its whole re-entry part: the handler's extra ask, `kind: 're-entry'`, `cause: 'lent'` and the ten-second re-ask. The rest of the paragraph is the same.
- [reference.md:105](../sources/claude-code-2.1.302/reference.md#L105) to line 127: the repository road for sharing a mod. It adds a secret scan with `mcp__plugin-authoring__scan_secrets` and `gh repo create --push`. An agent that follows the `plugin-authoring` skill will offer to share the mod once it works. [SKILL.md:25](../sources/claude-code-2.1.302/SKILL.md#L25) adds the matching paragraph. Process only. No API change.
- [reference.md:189](../sources/claude-code-2.1.302/reference.md#L189): `$.ui.copy` notes on VTE terminals. [reference.md:192](../sources/claude-code-2.1.302/reference.md#L192): the `$.ui.view` paragraph.
- Wording only, no change in meaning: many doc comments on `session.append` raise sites ("every attached surface"), caches (`prompt.section`, `tool.describe`), and the `agent.spawn` workflow fields.

## Observed, not in the types

*verified-kit,* `claude plugin validate` and `claude plugin test` on 2.1.302.

- **`$` may now go to an imported `function` declaration.** On 2.1.295 and 2.1.296 `probe($)` imported from `./helper` failed with `$ is followed only into a function declared in this same file, never across an import`. On 2.1.300, 2.1.301 and 2.1.302 it passes: `calls: $.process.run (via probe)`. An imported arrow `const` still fails, and so do methods and constructors. The release in between is unknown. Details: [ports-and-injection](../concepts/ports-and-injection.md#passing-the-engine-interface).
- **`on` may go to a plain named function in another file.** This rule is on no earlier page. Details: [ports-and-injection](../concepts/ports-and-injection.md#passing-on).
- **A hooks module may import from a sibling folder of `hooks/`** inside the plugin folder. An import that leaves the plugin folder is refused. See [develop](../workflow/develop.md#sibling-folders-beside-hooks).
- **`classic.SessionStart` and `classic.SessionEnd` function hooks of a `--plugin-dir` mod never ran** in a live session on this machine. `validate` prints the reason. *verified-live.* See [lifecycle](../concepts/lifecycle.md#clear).
- **A hook is still not run beneath its own call.** An `on('session.append')` hook that appended a row, and an `on('tool.call')` hook that called `$.tool.call` (Read), once per run (cap 3), ran once. It did not see its own call. The same held for ports built from another hook's `$`, for a `$.clock.after(0)` timer the hook armed, with and without `.catch`, and for a cycle across two events. A peer hook on the same event is seen (`invA=2 invB=2`). The kit and a headless `claude -p` run against a fake API gave byte-identical logs. The d.ts still states the rule: "a plugin's call runs the same chain with the calling hook alone skipped" ([d.ts:4843-4844](../sources/claude-code-2.1.302/types/claude-code.d.ts#L4843-L4844)). 2.1.302 dropped only the names `re-entry` and `lent`. Details: [dispatch-and-guards](../concepts/dispatch-and-guards.md#a-hook-is-not-run-beneath-its-own-call).
- **A `ui.render` hook that calls `$.ui.invalidate('ui.render')` is run again**, once per call (cap N: N+1 draws). `$.ui.invalidate` is not an `EventCalls` member ([d.ts:2381-2393](../sources/claude-code-2.1.302/types/claude-code.d.ts#L2381-L2393)). Kit only: the live pace is untested.
- **The kit refuses an unstubbed `$.fs` call** and fails a bare-value stub with `returned something that is not a result object`. See [fs-and-config](fs-and-config.md#in-the-test-kit).

## Known discrepancies

- [SKILL.md:17](../sources/claude-code-2.1.302/SKILL.md#L17) still says the types file has "about 14,000 lines". It has 22,255.
- [reference.md:168](../sources/claude-code-2.1.302/reference.md#L168) still says a record queued by a plugin's own `$.prompt.submit` or `$.command.run` is raised under the hook's frames, "so that hook is not run on it (the re-entry rule)". The sentence is right about the behaviour: the calling hook is skipped (see [Observed](#observed-not-in-the-types)). Only its name is old. The failure kind `re-entry` and the long `.catch` re-ask text are gone from reference.md:79 and from the types. The rule itself is still in the types ([d.ts:4843-4844](../sources/claude-code-2.1.302/types/claude-code.d.ts#L4843-L4844), [d.ts:3099-3100](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3099-L3100)). The same line is in the 2.1.295 snapshot.

## Pages that quote the 2.1.295 wording

These pages keep their 2.1.295 text. They are listed so a reader knows which sentences to trust less. A page marked fixed now carries a 2.1.302 note.

- [dispatch-and-guards](../concepts/dispatch-and-guards.md): fixed. `next.error.kind` and `cause` rows say what 2.1.302 dropped. The re-entry section is now [A hook is not run beneath its own call](../concepts/dispatch-and-guards.md#a-hook-is-not-run-beneath-its-own-call).
- [glossary](../concepts/glossary.md): fixed. The rows for `.catch`, `lent` and `re-entry`.
- [engine-interface](engine-interface.md): fixed. The skip bullet and the `HookFailure` row.
- [events](events.md): fixed. A [2.1.302 note](events.md#changes-in-21302) covers `turn.start`, `agent.spawn`, `prompt.change`, `prompt.submit` and the `session.append` door `queue`.
- [gotchas](../gotchas.md): rows 4, 5, 10, 11, 14 and 25 keep the 2.1.295 text and add a **2.1.302** note with its grade. Rows 35 and up are new.

## See also

- [lifecycle](../concepts/lifecycle.md)
- [ports-and-injection](../concepts/ports-and-injection.md)
- [fs-and-config](fs-and-config.md)
- [sources/README](../sources/README.md#claude-code-21302)
