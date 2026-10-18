# Spikes, 2026-10-17

Source files and small captures of the throwaway mods that back the graded claims in the [mods KB](../../README.md) and the [mod-architecture KB](../../../claude-code-mod-architecture/README.md). They ran for [issue #55](https://github.com/martin-macak/claude-code-mod-tracking/issues/55) on Claude Code **2.1.302**, macOS, on 2026-10-17. A spike is a tiny mod that answers one question.

This folder is evidence, not product. It is a snapshot: do not edit it. To redo a spike, copy its folder out, fix the paths (see below), and follow the recipe in the KB page that cites it.

## What is here

- One folder per spike, with only its source: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/**/*.ts(x)`, `tests/*.ts`, `types/index.d.ts` and the sibling source folders `core/` and `trackers/`.
- `live2-lifecycle/`, `live2-table/`, `live-life/`, `live-ui/`, `kit-fs/out-real/`: small captured output (`*.txt`, `*.log`, each under 50 KB). They are the run output of the spike with the nearest name. They hold no code.
- `tbl-drive/`, `hl/` and `live-life/bin/`: the tmux drivers, the screen analysers, the headless runner and the torn-read readers that the spikes used (`d.py`, `an.py`, `hs.py`, `run.sh`, `scn.sh`, `reader.py`, `reader2.py`, `reader3.py`).
- 518 files, about 445 KB in total. 84 spike mods and 6 folders of captures or drivers.

## What is not here

- `node_modules`, `.claude-plugin/types/` (the engine writes it), and any copied engine `claude-code.d.ts`. The two `a.d.ts` files in `g13q` and `g13r` are the spikes' own test input, not engine types. The authority is [claude-code.d.ts](../claude-code-2.1.302/types/claude-code.d.ts).
- `tsconfig.json` files. The settings that mattered are in [validate-test-debug](../../workflow/validate-test-debug.md#2-tsc--p): `target` and `lib` `es2023` (`es2024` for `width-spike`), `types: []`, `moduleResolution: bundler`, `strict`, and an `include` that lists the 2.1.302 `claude-code.d.ts`, `hooks`, `types` and `tests`.
- Color captures (`*.ansi`), the per-event JSON files of `live2-lifecycle/out/` (85 files; the 33-line `lifecycle-log.txt` quotes them), the 311 KB `live2-table/out/debug.log` (the pages quote its `[WARN]` lines), and the fake API server (`fake-api.mjs`; the same server is in [claude-code-link-capture sources](../../../claude-code-link-capture/sources/live-observations-2026-10-10/fake-api.mjs)).
- Unquoted captures. 42 of the 66 `live2-table/out/cap-*.txt` screens are left out. `live-ui/` has no code and keeps only two 276-byte logs.

## Paths

The spikes wrote their output under the scratch folder of the session. The snapshot replaces that absolute path:

- `<SPIKES>` stands for the folder that held all the spike folders.
- `<SCRATCH>` stands for the folder above it.
- The debug-mode notice of the engine names that folder. In the `live2-table/out/cap-*.txt` screens the notice wraps over 9 or 10 rows of the left column. Its text is replaced with `▎ <debug-log notice>`, and the `▎` marker stays on every row of the block. The layout stays aligned.

Set both to a folder of your own before you run a spike. A `--plugin-dir` folder is watched, so keep a spike's output folder **outside** the spike folder, or the mod reloads at every write. This is the same replacement the [2.1.295 snapshot](../README.md#claude-code-21295) made with `<SKILL_DIR>`.

## Grades

- `verified-kit`: `claude plugin validate`, `claude plugin test`, `tsc`, or a headless `claude -p` run against a fake API.
- `verified-live`: an interactive Claude Code session in tmux.

For the static-reader spikes (`g01*`, `g02*`, `g13*`, `g14`, `g19*`, `kbv-v*`, `kbw-*`) the Result column quotes `claude plugin validate <folder>`, **re-run on 2026-10-18 with 2.1.302**. A kit or headless result is on the KB page in the Page column. Messages are cut by the validator at about 200 characters.

## Passing `on` to other files

Page: [ports-and-injection](../../concepts/ports-and-injection.md#passing-on), [tracker-plugins §2.1](../../../claude-code-mod-architecture/tracker-plugins.md#21-passing-on-to-another-file).

| Spike | Question | Grade | Result |
| --- | --- | --- | --- |
| `g01a-on-fn` | Does a hook that an imported function registers load and fire? | `verified-kit` | Pass. `hooks: tool.call{tool=Bash}`. The kit test sees `{ deny: 'a-fired' }`. |
| `g01b-on-class-field` | `on` stored in a class field: `new TrackerB(on).attach()` | `verified-kit` | Fail. `"on" is used other than as a call or an argument to a function of the module's own`. |
| `g01c-on-method-param` | `on` passed to a method: `new TrackerC().attach(on)` | `verified-kit` | Fail. `"on" is passed to something other than a function named at the top of this file or imported from one of the module's own files`. |
| `g01d-neg-bad-event` | Does the scan read an imported file? A misspelled event only there. | `verified-kit` | Fail. `"tool.calls" is not an event`, reported against `trackers/d.ts`. Yes, it reads imports. |
| `g01e-neg-computed-name` | `on(EVENT, …)` with a `const` name | `verified-kit` | Fail. `the event name passed to on() is not a string literal`. |
| `g01h-on-object-method` | `on` passed to an object method: `trackerH.install(on)` | `verified-kit` | Fail. Same message as `g01c`. |
| `g01i-on-loop-fn-array` | `for (const install of INSTALLERS) install(on)` | `verified-kit` | Fail. `the callee "install" is not a function declared at the top of this file … nor imported`. |
| `g01i2-on-foreach-fn-array` | `INSTALLERS.forEach(install => install(on))` | `verified-kit` | Fail. `the value of install(on) is kept (assigned, passed, read, or returned from a nested function)`. |
| `g01j-on-fn-chain` | A chain `register` to `installAll(on)` to `installA(on)` and `installB(on)`. `installA` is an arrow `const`. | `verified-kit` | Pass. `hooks: tool.call{tool=Bash}, tool.call{tool=Read}, turn.complete`. |
| `g01k-dollar-in-tracker-file` | Extra arguments beside `on`. A `function` declaration in the tracker file takes `$`. | `verified-kit` | Pass. `calls: $.clock.now (via nowOf)`. |
| `g01k2-dollar-to-import-fn` | `$` passed to a `function` declaration imported from `trackers/util.ts` | `verified-kit` | Pass on 2.1.302. `calls: $.clock.now (via nowOf)`. |
| `g01k3-neg-dollar-to-method` | `$` passed to a class method: `svc.now($)` | `verified-kit` | Fail. `$ itself is passed as an argument (bound, passed, spread, returned or read)`. |
| `g01l-dup-matcherless` | Two `on('turn.complete', hook)` calls with no matcher, in two files | `verified-kit` | Fail. `on("turn.complete") is registered twice without a matcher; the first is at …/trackers/a.ts:2`. The kit prints `HooksError: … hooks module did not load`. |
| `g01m-dup-same-matcher` | Two hooks with the same matcher `{ tool: 'Bash' }`, in two files | `verified-kit` | Pass. `hooks: tool.call{tool=Bash}, tool.call{tool=Bash}`. Both run, nested in registration order. |
| `g01n-matcherless-plus-matcher` | One matcherless hook and one matcher hook for one event | `verified-kit` | Pass. `hooks: tool.call, tool.call{tool=Bash}`. |
| `g01o-two-different-matchers` | Two matchers, `Bash` and `Read`, in two files | `verified-kit` | Pass. `hooks: tool.call{tool=Bash}, tool.call{tool=Read}`. |
| `g01q-dollar-imported-arrow` | `$` passed to an imported arrow `const` | `verified-kit` | Fail. `$ is passed to "nowOf", a name bound to a function expression, outside the hook's own file`. |
| `g01r-dollar-samefile-arrow` | `$` passed to an arrow `const` of the same file | `verified-kit` | Pass. `calls: $.clock.now (via nowOf)`. |
| `g01u-conditional-and-trycatch` | `try { installA(on) } catch {}` and `if (options.withB === true) installB(on)` | `verified-kit` | Pass. `hooks:` lists B whatever the condition says. The kit switches B with `test(name, { options }, body)`. |

## Ports and passing `$`

Page: [ports-and-injection](../../concepts/ports-and-injection.md#the-ports-object), [tracker-plugins §2.2](../../../claude-code-mod-architecture/tracker-plugins.md#22-passing--and-building-ports).

| Spike | Question | Grade | Result |
| --- | --- | --- | --- |
| `g02-ports-object` | A ports object of 14 closures over six nouns, built by one same-file `portsOf($)` and passed to `new Manager(portsOf($))` of an imported class | `verified-kit` | Pass. `calls: $.clock.after (via portsOf), $.clock.every (via portsOf), …`. The kit and a headless real-engine run kept the closures alive in timers and later dispatches. |
| `g02b-ports-factory-in-import` | The same, with `portsOf` an imported `function` that takes `$` and returns closures | `verified-kit` | Pass. Same `(via portsOf)` list. |
| `g02c-method-shorthand-and-nested` | Method shorthand, a nested `function` and an `async` method inside `portsOf` | `verified-kit` | Pass. `calls: $.clock.after (via portsOf), $.clock.now (via portsOf), $.store.get (via portsOf), $.store.set (via portsOf)`. |
| `g14-ports-family-param` | A family state port whose `id` is a parameter of the closure | `verified-kit` | Pass. The inline literal `{ plugin, key, id } as const` sits inside the closure. |
| `kbv-v1` | Variant v1: a closure over `$`, `new GhTool(argv => $.process.run(argv))` | `verified-kit` | Pass. |
| `kbv-v2` | v2: `probe($)` where `probe` is a `function` declaration imported from `./helper` | `verified-kit` | Pass on 2.1.302. It failed on 2.1.295 and 2.1.296. |
| `kbv-v3` | v3: `new Thing($).go()` | `verified-kit` | Fail. `$ itself is passed as an argument`. |
| `kbv-v4` | v4: `const p = $.process` | `verified-kit` | Fail. `$.process is used as a value`. |
| `kbv-v5` | v5: `new Item().refresh($)`, a method of a class | `verified-kit` | Fail. `$ itself is passed as an argument`. |
| `kbv-v6` | v6: `held = $` into a module variable | `verified-kit` | Fail. `$ itself is assigned`. |
| `kbv-v7` | v7: `const run = $.process.run` | `verified-kit` | Fail. `$.process.run is used as a value`. |
| `kbv-v8` | v8: a closure over `$` kept in a module variable and used from `$.clock.after` | `verified-kit` | Pass. |
| `kbv-v9` | v9: two matcherless `on('session.append')` calls | `verified-kit` | Fail. `on("session.append") is registered twice without a matcher`. |
| `kbv-v10` | v10: a same-file `function runnerOf($)` | `verified-kit` | Pass. |

The ten variants come from [mod-api-notes §9](../../../claude-code-artifact-tracking/mod-api-notes.md#9-gotchas-that-bite-this-design). On 2.1.302 only v2 changed.

## State references and the contract

Page: [tracker-plugins §2.3](../../../claude-code-mod-architecture/tracker-plugins.md#23-state-refs-and-the-contract), [state-and-storage](../../concepts/state-and-storage.md). Plugin name `g13` in all of them.

| Spike | Question | Grade | Result |
| --- | --- | --- | --- |
| `g13a-atom-in-import` | An `atom` const exported from a tracker file and used in `register.ts` | `verified-kit` | Fail. `the state library's update takes a source the scan can read: a reference whose plugin and key are string literals`. |
| `g13b-plain-ref-in-import` | A plain ref const imported and passed to `$.state.get` | `verified-kit` | Fail. `$.state.get takes a reference whose plugin and key are string literals`. |
| `g13c-family-ref-builder` | A `slot(id)` ref builder exported from a tracker file, used with `read` and `update` in another | `verified-kit` | Fail. Same message. |
| `g13c2-family-direct-state-get` | The same builder passed to `$.state.get(slot(tracker.id))` | `verified-kit` | Fail. `$.state.get takes a reference whose plugin and key are string literals`. This is the form that failed in the lifecycle run. |
| `g13d-family-atom-in-class` | An `atom` made in a class constructor | `verified-kit` | Fail. The scan cannot read the reference. |
| `g13e-atom-and-use-same-file` | The atom and its use in one tracker file | `verified-kit` | Pass. `state reads: g13.a`. |
| `g13f-family-same-file` | A `slot(id)` builder in the same file as the call | `verified-kit` | Fail. A builder fails even in the same file. |
| `g13g-accessor-fn-takes-dollar` | `bumpA($)` and `readA($)` exported as arrow `const`s | `verified-kit` | Fail. `$ is passed to "bumpA", a name bound to a function expression, outside the hook's own file`. |
| `g13i-neg-spread-ref` | A same-file base spread into the ref: `{ ...BASE, key: 'a' }` | `verified-kit` | Pass, although the name says negative. `state reads: g13.a`. |
| `g13j-neg-key-not-declared` | A ref to `g13.zzz`, which the contract does not name | `verified-kit` | Fail. `g13.zzz is not declared: the manifest's types contract must name it`. |
| `g13k-generic-state-port` | A generic port `read: a => read($, a)` | `verified-kit` | Fail. `the state library's read takes a source the scan can read`. |
| `g13l-family-inline-literal` | A family member with a computed `id`, as an inline literal at the call | `verified-kit` | Pass. |
| `g13m-family-const-in-hook` | The same ref as a `const` inside the hook body | `verified-kit` | Pass. |
| `g13n-family-atom-in-install` | An `atom` made inside `installA(on, tracker)` with `id: tracker.id` | `verified-kit` | Pass. |
| `g13o-accessor-declaration` | `bumpA($)` as an exported `function` declaration with a file-local atom | `verified-kit` | Pass. |
| `g13p-family-two-trackers-unknown` | Two trackers (`github`, `jira`) under one family key, a computed matcher | `verified-kit` | Pass. `hooks: tool.call{tool=?}`. `validate` lists the key once. |
| `g13q-neg-second-dts` | A tracker-owned `.d.ts` that `plugin.json` does not name | `verified-kit` | Fail. `g13.zzz is not declared`. |
| `g13r-types-array` | `types` as an array in `plugin.json` | `verified-kit` | Fail. `Invalid input: expected string, received array`. |
| `g13s-family-spread-samefile-base` | `{ ...SLOTS, id: tracker.id }` with `SLOTS` in the same file | `verified-kit` | Pass. |
| `g13t-family-spread-imported-base` | The same with `SLOTS` imported | `verified-kit` | Fail. The scan cannot read the imported base. |

## Where the code lives, and other loader rules

Page: [tracker-plugins §2.4](../../../claude-code-mod-architecture/tracker-plugins.md#24-where-the-code-may-live), [ports-and-injection](../../concepts/ports-and-injection.md#where-the-code-may-live).

| Spike | Question | Grade | Result |
| --- | --- | --- | --- |
| `g19a-sibling-core` | May `register` import from a sibling folder of `hooks/`, and may such a file register hooks? | `verified-kit` | Pass. `hooks: tool.call{tool=Bash}, tool.call{tool=Read}`. A headless real-engine run loaded it too. |
| `g19b-neg-outside-root` | An import that leaves the plugin folder (`../../shared/x`). The plugin is in `plug/`. | `verified-kit` | Fail. `cannot import "../../shared/x" (from hooks/register.ts): it is outside the plugin's folder`. |
| `kbw-async` | May `register` be `async`? Does `on()` after an `await` register? | `verified-kit` | Pass. `hooks: tool.call{tool=Bash}`. The kit hook fires. |
| `kbw-compose` | Do two `ui.render` hooks with one matcher from two files compose? | `verified-kit` | Pass. `hooks: ui.render{component=Pane, requestId=p}, ui.render{component=Pane, requestId=p}`. The first is outermost. |
| `kbw-env` | Do `$.env.get('HOME')` and `$.env.get('XDG_CONFIG_HOME')` pass in `portsOf` closures? | `verified-kit` | Pass. `calls: $.env.get (via portsOf)`, `env reads: HOME, XDG_CONFIG_HOME`. |
| `kbw-npm` | A bare package import, `import { camelCase } from 'lodash'` | `verified-kit` | Fail. `cannot import "lodash" (from hooks/register.ts): a hooks module imports its own files by relative path and "claude-code", nothing else`. |

## Kit spikes

| Spike | Question | Grade | Result | Page |
| --- | --- | --- | --- | --- |
| `kit-end` | What does `$.session.end` do in the kit? Which reasons reach the hook? What do `$.session.id()` and `$.state` hold inside? | `verified-kit` | All five reasons reach the hook. Inside it the id is the leaving stub id and the state is intact. The kit resets nothing and reports `next.budget.ms` as 10000. | [lifecycle-manager §3.4](../../../claude-code-mod-architecture/lifecycle-manager.md#34-what-the-kit-can-drive) |
| `kit-focus` | May a `ui.focus` hook write state that a Pane render reads? Does a render hook that writes get refused? | `verified-kit` | The `ui.focus` write moves the highlight with no redraw call. A render hook that writes fails with `state.set: denied: it was made while ui.render is being dispatched`. | [tree-table §3.3](../../../claude-code-mod-architecture/tree-table.md#33-selection-state) |
| `kit-fs` | What does the kit do with an unstubbed `$.fs` call? Does a test body have an `fs` noun? | `verified-kit` | An unstubbed call is refused and never reaches the disk. The `Engine` type has no `fs` noun (`TS2339`). | [fs-and-config](../../reference/fs-and-config.md#in-the-test-kit) |
| `kit-tree` | How many rows does a Pane tree take before the 20,000-node refusal and the 100,000-character cut? | `verified-kit` | The node refusal comes at 908 rows with detail rows (1,051 without). The text cut removes the `Button`s from row 907 (flat rows, short keys) or row 248 (real `Box` key format). | [limits-and-diagnostics](../../reference/limits-and-diagnostics.md#sizing-a-table-in-a-pane) |

## First live and headless spikes

| Spike | Question | Grade | Result | Page |
| --- | --- | --- | --- | --- |
| `life-spike` | `$.fs` under `HOME` (G05), `session.end` on `/clear` (G07), events seen before a hot reload (G12), `$.fs.write` atomicity (G18). Output folder: `live-life/` (only `out/sh-hook.txt` kept). | `verified-live` | `session.end` on `/clear` sees the old id and the old state, and `$.store.set` plus `$.fs.write` finish in a few ms. A reload sends nothing to the old copy. | [lifecycle-manager §3.1](../../../claude-code-mod-architecture/lifecycle-manager.md#31-start-clear-and-end) |
| `life-spike-next` | An earlier version (`v5`) of `life-spike`, without the 256 KiB payload probe. | `verified-live` | Same findings, smaller payload. | same |
| `ui-focus` | Pane keys, the focus ring and hotkeys (G03, G09, G10, G14), colors (G16) and a `Client` region (G08). Output: `live-ui/events.log`. | `verified-live` | Tab walks every `Button`. Up and Down scroll while the tree overflows. All 36 hotkeys fire. A `Client` needs a mouse click. | [tree-table §3.2](../../../claude-code-mod-architecture/tree-table.md#32-keyboard) |
| `live-probe` | Ports built in `session.start` and used from timers and later dispatches, in a headless real-engine run with a fake API. Output JSON is not kept. | `verified-kit` | The ports kept working (`"bumpOk":5,"ticks":5,"afterFired":1`). | [tracker-plugins §2.2](../../../claude-code-mod-architecture/tracker-plugins.md#22-passing--and-building-ports) |
| `live-state-snapshot` | The same, without `rawGet` and `rawSet` and with a `manager.start()` that is not awaited, to read the state view in a dispatch. | `verified-kit` | A `command.run` hook read `{"version":0}` for 1 s after a timer's `update` resolved. | [lifecycle-manager §3.2](../../../claude-code-mod-architecture/lifecycle-manager.md#32-reading-state-inside-a-dispatch) |

## Second pass: lifecycle and hot reload

Spike `lifecycle-mod`. Output and captures: `live2-lifecycle/`. Page: [lifecycle](../../concepts/lifecycle.md), [lifecycle-manager §3](../../../claude-code-mod-architecture/lifecycle-manager.md#3-what-the-engine-allows), [tracker-plugins §2.3 and §2.4](../../../claude-code-mod-architecture/tracker-plugins.md#23-state-refs-and-the-contract).

| Spike | Question | Grade | Result |
| --- | --- | --- | --- |
| `lifecycle-mod` | R-Q5: does an edit to `core/x.ts` (a sibling of `hooks/`) hot-reload the mod? | `verified-live` | Yes, like an edit to `hooks/register.tsx`. The new copy gets `register` and `session.start` 0.5 to 0.65 s after the save. A transitive import reloads too. A file nothing imports does not. An identical save does not. Module variables and the old timer are gone. |
| `lifecycle-mod` | R-Q22: what do `e.reason`, `$.session.id()` and `$.state` hold in `session.end` for `/clear`, `/resume`, `/branch`? Do timers and module variables survive? | `verified-live` | `session.end` sees the leaving session. `/clear` gives `clear`. `/resume` and `/branch` both give `resume`. The module copy, its variables and its timer survive. `$.state` is empty afterwards. No `session.start`. After `/resume` no row came for 4.8 s. |
| `lifecycle-mod` | R-Q9: does a `StateFamily` member with an `id` taken from a tracker object work live? | `verified-live` | Yes. Two ids hold separate values. `validate` lists the key once. The values do not survive `/clear`. A `slot(tracker)` ref builder fails `validate`. |
| `live2-lifecycle` | Output of the three rows above. | `verified-live` | `lifecycle-log.txt` (33 lines), `validate-output.txt`, and `cap/*.txt`, the tmux screens in order. |

## Second pass: tree table

Spike `tbl`, driven by `tbl-drive/`. Output and captures: `live2-table/`. Page: [tree-table §3 and §5](../../../claude-code-mod-architecture/tree-table.md#3-what-the-engine-allows), [ui](../../reference/ui.md#ring-walk-and-scroll).

| Spike | Question | Grade | Result |
| --- | --- | --- | --- |
| `tbl` | R-Q1-E2E (a): does the highlight follow Tab, and does the ring stay on the same `Button` after the redraw? | `verified-live` | Yes. One `ui.focus` event per Tab, then one render. No second focus event, so the ring did not jump. |
| `tbl` | (b) Does a hotkey act on the selected row? | `verified-live` | Yes. `x` wrote `last action: x on row 4`. A hotkey does not move the ring. |
| `tbl` | (c) What happens to the selection when the ring lands on a footer `Button` or the close mark? | `verified-live` | The literal hook loses it. A hook that writes only for row keys keeps it. |
| `tbl` | (d) Does Enter toggle detail rows and keep the ring? | `verified-live` | Yes. The ring stays. Tab skips `Text`-only detail rows. |
| `tbl` | R-PERF: time per Tab at 100, 300, 600 and 1300 rows | `verified-live` | Last changed frame: 29, 58, 109 and 221 ms. About 0.17 ms per row. |
| `tbl` | R-Q2: do the 20,000-node refusal and the 100,000-character cut apply live? | `verified-live` | Yes, as in the kit. 1300 rows draw. 1400 rows are refused. 600 rows of 200-character titles lose `Button`s from row 470. |
| `tbl` | `autoFocus` on the first row `Button` | `verified-live` | The ring starts there. The first Tab goes to the second row. Without it the first Tab lands on row 0. |
| `tbl-drive` | The drivers: `d.py` (tmux input and timing), `hs.py` (events summary), `an.py` (reads a colored capture: ring and highlight per row). | n/a | Scripts only. |

## Second pass: re-entry, the bus and composition

Page: [dispatch-and-guards](../../concepts/dispatch-and-guards.md#a-hook-is-not-run-beneath-its-own-call), [tracker-plugins §2.1](../../../claude-code-mod-architecture/tracker-plugins.md#21-passing-on-to-another-file). `r02*`, `r03` and `r04` ran in the kit and in a headless real-engine run through `hl/run.sh`. The two logs matched byte for byte. `r05` to `r07s` ran in the kit. `r06d` ran headless only.

| Spike | Question | Grade | Result |
| --- | --- | --- | --- |
| `r01-append` | First probe: does an `on('session.append')` hook that calls `$.session.append` see its own row? | `verified-kit` | No. `STATS {"inv":1,"maxDepth":1}` in all three variants (same text before, unique text before, unique text after), re-run with `claude plugin test` on 2026-10-18. |
| `r02-reentry` | The same, through the hook's own `$`, ports from `command.run`, a timer, identical and unique row text, append before and after `next(e)`, and a peer hook B | `verified-kit` | `invA=1` in every variant. With a peer: `invA=2 invB=2`. The skip is per hook along the call chain. |
| `r02c-reentry` | The same with `.catch((_$, e, next) => next(e))` on the hook | `verified-kit` | `invA=1`. `validate` prints `gating hook with .catch: session.append`. |
| `r02s-reentry` | The same with ports built from the `session.start` hook's `$` | `verified-kit` | `invA=1`. |
| `r03-toolcall` | The same for `on('tool.call')` and `$.tool.call` (Read) | `verified-kit` | `invA=1`. With a peer on `{ tool: 'Read' }`: `invA=2 invB=2`. |
| `r04-cycle` | A cycle: S (`session.append`) calls `$.tool.call`, T (`tool.call`) calls `$.session.append`, both capped at 6 | `verified-kit` | `invS=1 invT=1` from either start. |
| `r05-render` | Does a `ui.render` hook that calls `$.ui.invalidate` run again? | `verified-kit` | Yes. With a cap of N it draws N+1 times: draws per step `1,1,1,…` (cap 0), `4,4,4,…` (cap 3), `4,8,12,16,20,21,21,…` (cap 20). Kit only. |
| `r06a-bus` | One matcherless `on('tool.call')` with a `Map` of handlers, and `on('session.append', { door: DOORS })` with a same-file literal | `verified-kit` | Pass. `hooks: tool.call, session.append{door=tool-result\|tool-message}`. Every handler fires. |
| `r06b-bus-imported` | `DOORS` imported from a file | `verified-kit` | Pass, with `session.append{door=?}` and an advisory. |
| `r06c-bus-computed` | `DOORS` computed from two trackers' declarations | `verified-kit` | Pass, with `door=?`. |
| `r06d-bus-live` | The imported-tracker bus in a headless real-engine run | `verified-kit` | The `Map` fans out to both trackers. The computed door set includes `note`. |
| `r07-compose` | Two `ui.render` hooks with one matcher: which is outermost, and what does each `next(e)` return? | `verified-kit` | The first registered is outermost. Its `next(e)` returns the second hook's tree. |
| `r07s-compose` | The same with the install order swapped | `verified-kit` | The order of registration decides the nesting. |
| `hl` | The headless runner: `run.sh` starts `claude -p` against the fake API with a fresh config folder. `scn.sh` runs several probes. | n/a | Scripts only. |

## Cell width

Spike `width-spike`. Page: [tree-table §3.5](../../../claude-code-mod-architecture/tree-table.md#35-cell-width).

| Spike | Question | Grade | Result |
| --- | --- | --- | --- |
| `width-spike` | Does a 65-line `cellWidth` (`Intl.Segmenter`, three Unicode-property regexes, a Wide table) match the live renderer? | `verified-live` | 24 of 24 strings. `tsc` 7.0.2 stops at target `es2023` with `TS1501` for the two `/v` regexes. It passes at `es2024`. |
