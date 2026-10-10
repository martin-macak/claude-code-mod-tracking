# Mod API notes for the tracking mod

The mod API pieces the tracking mod needs, checked against Claude Code 2.1.295 (cross-checked on 2.1.296). It does not repeat mod basics. Read the [mods KB](../claude-code-mods/AGENTS.md) and its [gotchas](../claude-code-mods/gotchas.md) first.

**Evidence tags.** *primary*: the types file ([d.ts](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts)) or [reference.md](../claude-code-mods/sources/claude-code-2.1.295/reference.md). *observed*: a run of the 2.1.295 binary, kept in [`sources/live-observations-2026-10-10/`](sources/live-observations-2026-10-10/README.md) (`outputs/...` below). *public-docs*: code.claude.com snapshot in the mods KB. *inference*: a guess.

## Summary

| # | Question | Short answer |
| --- | --- | --- |
| 1 | `$.process.run`, tool not on PATH | Rejects. It searches PATH. Inherits the host env. Probe `<tool> --version` once and cache. |
| 2 | Stub in tests | Yes, with `on('process.run', ...)`, `on('session.repo', ...)`, `mock.clock`, `mock.store`. The test `$` itself has no `process`, `store`, `clock`, `state` or `session.repo`. |
| 3 | `prompt` door | Use `door === 'prompt'`, `origin.kind` in an allow-list, no `isMeta`, no `agentId`. Or hook `prompt.submit`. |
| 4 | `$.session.repo()` | `{ root, remote, internal, name }`. `name` is null for public repos. Parse `remote` yourself. |
| 5 | Timers | A callback may call `process.run` and write `$.state`. No time limit seen up to 45 s. They survive `/clear`. A hot reload drops them. |
| 6 | Pane | `$.state` writes redraw it by themselves. A tree table works with `Box` cells. `Link` draws OSC 8. |
| 7 | Commands | `$.command.register` in `session.start`, `command.run` hook per name. |
| 8 | State | `$.state` plus a `$.store` mirror. `/clear` resets `$.state`. Detect it by a changed session id. |
| 9 | Gotchas | `$` may not cross a call. A closure `(argv, init) => $.process.run(argv, init)` may. Classes are fine. |

## 1. `$.process.run`

Signature: `run(argv, init?) => Promise<{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }>` ([d.ts:3515](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L3515), [ProcessRunInit d.ts:7999](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L7999), [ProcessRunResult d.ts:8026](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L8026)). No shell. *primary*

| Question | Answer | Tag |
| --- | --- | --- |
| `argv[0]` not on PATH | The promise **rejects**. It does not resolve with an exit code. | *primary* (d.ts:3505 "Rejects when the command cannot start"), *observed* |
| Error text | `HooksError`, message `<plugin>: $.process.run(<argv0>) failed to start: ENOENT: Executable not found in $PATH: "<argv0>"`. The prefix is the plugin name. Same text on 2.1.295 and 2.1.296. | *observed* ([A1](sources/live-observations-2026-10-10/outputs/probe-run.2.1.295.json)) |
| Does it search PATH? | Yes. `gh` resolved to the Homebrew binary. An absolute path works too. | *observed* (A2, A10b) |
| Which PATH? | The host process PATH. The child PATH equals `$.env.get('PATH')` (50 entries). `init.env` values go **over** the host env. | *primary* (d.ts:8006, 3581), *observed* (A5d) |
| `init.env.PATH` | It also changes the lookup. `gh` was not found with `env: { PATH: '/usr/bin' }`. Do not set `PATH` in `init.env`. | *observed* (A11) |
| Relative `./gh` | Not searched on PATH. `ENOENT ... posix_spawn './gh'`. | *observed* (A10), *inference* for the rule |
| Other start errors | Not executable: `EACCES: permission denied, posix_spawn '/etc/hosts'`. Empty `argv`: `process.run: takes argv, a non-empty list of strings naming the command first (host check)`. | *observed* (A14, A9) |
| Non-zero exit | **Resolves** (`exitCode: 3`). A child killed by a signal reads as `exitCode: 1`. | *primary* (d.ts:8028), *observed* (A15, A15b) |
| Timeout | `init.timeoutMs`, default 30 s, at most 10 min. The call rejects: `<plugin>: $.process.run(sleep) aborted: still running after 1000ms`. | *primary* (d.ts:3509, 8014), *observed* (A7) |
| `cwd` | Default is the session's working directory. A relative `cwd` is relative to it. | *primary* (d.ts:7999-8004), *observed* (A8, A8b, A8c) |
| Bad `cwd` | Rejects with `ENOENT: no such file or directory, posix_spawn '<argv0>'`. This looks like "tool missing" but lacks the words `Executable not found in $PATH`. | *observed* (A8d) |
| Output cap | 4 MiB for stdout and for stderr each. | *primary* (d.ts:8032, 8041) |
| Concurrency | Calls run in parallel: three `sleep 1` finished in 1007 ms. | *observed* (A16) |
| Env hygiene | The child inherits everything the host has (`GH_TOKEN`, `GH_HOST` if set). Git runs with repo hooks off. | *primary* (d.ts:3505), *observed* (A5c: the engine's own variables are there too) |
| Cost | `gh --version` 34 ms. `acli --version` 595 ms, and it prints an "outdated version" notice. | *observed* (A2, A3) |

### Detecting a tool cheaply

`command -v` is a shell builtin. It needs `sh -c`; that works (`['sh','-c','command -v gh']` gave `/opt/homebrew/bin/gh`, A6) but adds a shell. `which` works on macOS and Linux (A4: exit 1 and no output when missing) but not on Windows. The portable probe is `[tool, '--version']`.

Recommendation (*inference* from the table):

- Probe once per tool and keep the **promise** in a map. A rejection or a non-zero exit means "not available". Do not parse the message text.
- Do not await the probe in `session.start`. `session.start` is awaited before the first prompt ([reference.md:154](../claude-code-mods/sources/claude-code-2.1.295/reference.md#L154)), and `acli --version` takes 0.6 s. Start it with `void probe()` or a short `$.clock.after`.
- `canRefresh()` must then be **synchronous** and read the cache. Treat "not probed yet" as false. After the probe settles, redraw (a `$.state` write does it).
- The cache is a module variable. A hot reload resets it. That only costs one more probe.
- A "tool installed but not logged in" state is not found by `--version`. It shows up as a non-zero exit of the real call. That feeds the circuit breaker, not `canRefresh()`.

Working code: `Availability` in [`probe-mod/hooks/tools.ts`](sources/live-observations-2026-10-10/probe-mod/hooks/tools.ts). Run live: [`probe-avail.txt`](sources/live-observations-2026-10-10/outputs/probe-avail.txt) (`gh: true` twice, `missing: false`).

## 2. Stubbing `$` calls in a test

Yes for all four. But the stubs sit **beneath the mod**. The test's own `$` is the engine's `$` ([Engine d.ts:15011](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L15011)). It holds only the nouns the engine raises: `tool`, `command`, `config`, `telemetry`, `prompt`, `skill`, `attribution`, `agent`, `session` (`start`, `receive`, `append`, `send`, `compact`, `attach`, `detach`, `measure`, `end`), `turn`, `ui`, `classic` (*observed*, `Object.keys($)`). It has no `process`, `store`, `clock`, `env`, `state` or `session.repo`. The test cannot call `$.process.run` itself. Only the mod's call reaches the stub. ([link-capture README §7](../claude-code-link-capture/README.md) says the same for `$.state`.)

| Thing | How | Source |
| --- | --- | --- |
| `$.process.run` | `on('process.run', (_$, e) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))`. `e` is `{ argv, init }`. | event [d.ts:7152](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L7152), *observed* |
| Failure of the tool | `on('process.run', () => ({ deny: 'ENOENT: Executable not found in $PATH' }))`. The mod's `await $.process.run(...)` **rejects** and the message holds the reason. | *observed* (`stubs.test.ts`) |
| No stub | The mod's call fails with `no implementation for process.run`. | *observed* |
| `$.session.repo()` | `on('session.repo', () => ({ value: { root: '/r', remote: 'git@github.com:o/r.git', internal: false, name: null } }))`, or `{ value: null }`. | event [d.ts:7215](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L7215), *observed* |
| `$.clock` | `const clock = mock.clock(on, { now })`. `await clock.advance(ms)` runs `$.clock.after` and `$.clock.every` callbacks that are due. | [testing-kit §4](../claude-code-mods/reference/testing-kit.md), [d.ts:15496](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L15496), *observed* |
| `$.store` | `mock.store(on, seed)`. To read back what the mod saved, write the four `store.*` stubs yourself (link-capture does). | [register.test.ts](../claude-code-link-capture/example/link-capture/tests/register.test.ts) |
| `$.env` | `mock.env(on, { HOME: '/h' })`. | testing-kit §4 |
| `$.state` | The kit answers it. The test has no `$.state`. Read it through a mod command, or through `$.ui.mount` and `find`. | [testing-kit §3](../claude-code-mods/reference/testing-kit.md) |
| Other `$` calls the mod makes at `session.start` | Stub them: `command.register`, `session.id`, `fs.write`, `ui.open`, and an engine answer for `session.start` itself. | *observed* |

Pattern from the probe tests ([`probe.test.tsx`](sources/live-observations-2026-10-10/probe-mod/tests/probe.test.tsx)):

```ts
function world(on: On, run: (argv: readonly string[]) => unknown) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const r = run(e.argv)
    return r && typeof r === 'object' && 'deny' in r ? { deny: r.deny } : { value: r }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return { clock }
}
test('timer fires a refresh', async ($, on) => {
  const { clock } = world(on, () => ok('gh version 2'))
  await $.command.run({ command: 'probe-timers', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await clock.advance(400)                      // the 300 ms timer ran
})
```

Register all stubs **before** the first call on `$` ([gotcha 32](../claude-code-mods/gotchas.md)). Each `test()` gets a fresh module and `$.state` ([gotcha 31](../claude-code-mods/gotchas.md)).

**Consequence for the OO design.** With an injected `run` function (see section 9), `TrackedItem`, `Tool` and `CircuitBreaker` are plain TypeScript with no `$`. Unit-test them with a fake `run` and no kit at all. Pure test files work under `claude plugin test` (`parseRemote` is tested that way). Use the kit only for `register.ts` wiring. *inference*

## 3. `session.append`: doors, origins, the person's own text

### Event and row shape

`session.append` fires once per row a conversation keeps ([d.ts:4359](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L4359), [reference.md:137](../claude-code-mods/sources/claude-code-2.1.295/reference.md#L137)). *primary*

```ts
// SessionAppendInput, d.ts:10566
{ message: { type: 'user'|'assistant'|'attachment'|'system', name?, role?, isMeta?: true, content: ApiContentBlock[] },
  door: 'prompt'|'command'|'response'|'tool-result'|'tool-message'|'delivery'|'attachment'|'hook-context'|'note'|'compaction'|'notice',
  origin: SessionAppendOrigin,   // pinned
  uuid: string,                  // pinned; same in the transcript file
  agentId?: string }             // subagent id; absent on main
```

`origin` is `PromptOrigin | PromptAttachmentOrigin | { kind: 'model', model } | { kind: 'tool', tool }` ([d.ts:10644](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L10644)).

`PromptOrigin.kind` has 16 values ([d.ts:8865-8984](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L8865)):

| Kind | Meaning (d.ts text, short) | Person's own text? |
| --- | --- | --- |
| `composer` | The user's own Enter at the terminal, stamped by the engine. | **Yes** |
| `bridge` | The user's message through Remote Control (phone, web). | **Yes** |
| `sdk` | The SDK host's own turn (`claude -p`, Agent SDK). | Yes (a program typed it) |
| `unclassified` | No provenance the engine can name. Also idle notices (those are `isMeta`). | Maybe |
| `task-notification` | A background task's notification. | No |
| `scheduled-trigger`, `peer`, `peer-send-message`, `projects-relay`, `channel`, `coordinator`, `observer`, `observer-activity`, `slack-ping` | Machines, other sessions, channels, coordinators. | No |
| `auto-continuation` | A follow-up to a UI action, "user-initiated but not typed this turn". | No |
| `plugin` (`name`, `asUser?`) | A plugin's `$.prompt.submit`. With `asUser` the model reads it as the person's words. | No (decide on `asUser`) |

`PromptAttachmentOrigin` is `engine`, `hook` (`event`) or `plugin` (`event`) ([d.ts:8180](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L8180)). Those come with doors `attachment`, `hook-context`, `note`, `notice`.

### What the rows looked like (observed)

| Input | Door | `origin` | `isMeta` | Notes |
| --- | --- | --- | --- | --- |
| Typed `hello #5 and https://typed.example/a` in the REPL | `prompt` | `{ kind: 'composer' }` | absent | `content: [{ type: 'text', text }]`. [row](sources/live-observations-2026-10-10/outputs/rows/001-prompt.json) |
| `claude -p go2` | `prompt` | `{ kind: 'unclassified' }` (not `sdk`) | absent | From the link-capture run: [subagent-background.json](../claude-code-link-capture/sources/live-observations-2026-10-10/rows/subagent-background.json). |
| Subagent opening prompt (written by Claude) | `prompt` | `{ kind: 'coordinator' }` | absent | Same file. This is Claude's text, not the person's. |
| Background subagent result | `prompt` | `{ kind: 'task-notification' }` | absent | Same file. Text in `<task-notification>`. `isMeta` does **not** exclude it. |
| User slash command `/foo #12 https://cmd.example/q` (a Markdown command file) | `command` | `{ kind: 'composer' }`, `type: 'user'` | absent | Text is `<command-message>foo</command-message>\n<command-name>/foo</command-name>\n<command-args>#12 https://cmd.example/q</command-args>`. [row](sources/live-observations-2026-10-10/outputs/rows/016-command.json) |
| The expansion of that command | `note` | `engine` | `true` | `Please look at #12 https://cmd.example/q and say ok.` It holds the command template text. |
| Plugin slash command `/probe-repo` | `command` (two rows) | `engine`, `type: 'system'`, `name: 'local_command'` | absent | The row holds `<command-args>` and, later, `<local-command-stdout>` with the command's own output. |
| `look at @<file> please` | `prompt` (typed text) + `attachment` | `composer`; attachment `engine`, `name: 'file'` | | The file text is in the attachment row only. |

### Keep only the person's own typed text

Recipe for `session.append` (*inference* from the table, rows *observed*):

```ts
const PERSON = new Set(['composer', 'bridge'])        // add 'sdk' (and 'unclassified') to track -p runs
on('session.append', { door: 'prompt' }, async ($, e, next) => {
  const stored = await next(e)
  if (PERSON.has(e.origin.kind) && !e.message.isMeta && e.agentId === undefined) {
    // scan text blocks of stored.message.content
  }
  return stored
}).catch(($, e, next) => next(e))
```

- Use an **allow-list** on `origin.kind`. A deny-list loses to new kinds.
- `task-notification` and `coordinator` rows have no `isMeta`. Only the origin tells them apart.
- Add `unclassified` only if `-p` runs matter. Require `!isMeta` then. This is a user decision (D3 in [open-questions](open-questions.md#4-decisions-for-the-user)).
- Rows with `door: 'command'` and `origin.kind === 'composer'` carry the arguments of a user's slash command. Parse `<command-args>…</command-args>` if you want them. Skip `command` rows with `origin: engine`: they hold your own `/track` output and would feed back into the tracker.
- `hook-context`, `attachment`, `note`, `notice`, `compaction`, `delivery`: never the person's typing.

**Alternative: hook `prompt.submit`.** Observed events: `prompt.submit` fired for the typed prompt and for `/foo #12 …` (`text: "/foo #12 https://cmd.example/q"`, `origin: composer`, `wait: false`). It did **not** fire for the plugin command `/probe-repo`, and the `@file` prompt arrived as typed text ([events](sources/live-observations-2026-10-10/outputs/events/)). `e.text` is the prompt "as it will reach the model (pastes already expanded)" ([PromptSubmitInput d.ts:9051](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L9051)).

| | `session.append` door `prompt` | `prompt.submit` |
| --- | --- | --- |
| Covers `/foo args` of a user command | No (door `command`, XML wrapped) | Yes, plain text |
| Origin | `e.origin` | `e.origin` (same `PromptOrigin`) |
| Row id for dedupe | `uuid` | none |
| Runs after the row is stored | Yes, after `next(e)` | Scan **before** `next(e)`. `next` resolves only when the turn starts. |
| Other hooks may drop the prompt | Row exists, so it was kept | A later hook may `drop` it after you scanned (*inference*) |
| Queued prompts, `agentId` | `agentId` on the event | `turnId`, `wait` |

### Response and tool-result doors (confirmed from link-capture)

- `door: 'response'`: origin `{ kind: 'model', model }`. One complete text block per row, in order; `tool_use` blocks come as separate rows. Subagents set `agentId`. ([link-capture §3](../claude-code-link-capture/README.md), [rows](../claude-code-link-capture/sources/live-observations-2026-10-10/rows/subagent-background.json)) *observed*
- `door: 'tool-result'`: origin `{ kind: 'tool', tool: 'Bash' }`. `content: [{ type: 'tool_result', tool_use_id, content: string | block[] }]`. Read both content shapes. Raw bytes stay (OSC 8 included). ([link-capture §5](../claude-code-link-capture/README.md)) *observed*
- Not appended: rows from `--resume` loads. Backfill from `$.session.messages()` (newest 4096). ([link-capture rule 12](../claude-code-link-capture/README.md))
- A `response` row is "Claude mentioned it". A `tool-result` row is "a tool printed it".

### Should tool-result rows count as "mentioned"? (user decides)

Decision D1 in [open-questions](open-questions.md#4-decisions-for-the-user).

| Pros | Cons |
| --- | --- |
| Catches items Claude learned but did not repeat: `gh pr list`, `gh pr view`, `git log` with `(#123)`, CI output. | Noise. `git log`, test output and file reads hold many `#N`, hex colors, headings, C `#1`. Bare `#N` has no context here. |
| Explicit GitHub and Jira URLs in tool output are high precision. | Web links explode. Fetched pages and logs hold hundreds of URLs the person never saw. |
| Covers work done by subagents whose final text is short. | Claude never "mentioned" them to the person. The tracker would show things the person did not see. |
| `tool` name in `origin` allows a filter (`Bash` only, or `WebFetch` only). | Volume and cost. A row may be megabytes. Scanning runs on every tool result. |
| | Secrets: tool output may hold tokens or private URLs. They would land in `$.store`. |

Middle path (*inference*): scan `tool-result` rows only for **explicit GitHub and Jira URLs**, and keep a `source` field (`prompt`, `response`, `tool`) on every item so the UI can filter. Never take bare `#N` from tool output.

## 4. `$.session.repo()`

```ts
// SessionRepo, d.ts:11463
{ root: string,            // absolute; the MAIN working tree's root for a worktree
  remote: string | null,   // the `origin` URL as git has it (push URL preferred); null when no origin
  internal: boolean,       // true only for the build's own repositories
  name: string | null }    // 'owner/name' only when internal; else null
```

`$.session.repo()` returns `SessionRepo | null` and reads the working copy **on each call**; null outside a git repository ([d.ts:2804](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L2804)). *primary*

*Observed* in this repo: `{ root: ~/projects/claude-code-mod-tracking, remote: 'git@github.com:<owner>/<repo>', internal: false, name: null }` ([A17](sources/live-observations-2026-10-10/outputs/probe-run.2.1.295.json)). So:

- `name` is useless here. It is null for every public or private repo that is not the build's own.
- You must parse `remote`. Forms to handle: scp `git@host:owner/repo(.git)`, `ssh://git@host[:port]/owner/repo(.git)`, `https://[user[:token]@]host/owner/repo(.git)`. `parseRemote` in [`tools.ts`](sources/live-observations-2026-10-10/probe-mod/hooks/tools.ts) does it and is tested for these forms (*observed*, 12 tests pass). Strip credentials from the URL before you store or show it.
- Keep the **host**. `github.com` is GitHub. Another host may be GitHub Enterprise, and `gh` then needs `GH_HOST` or `-R host/owner/repo` (*inference*; see [github.md §10](github.md#10-github-enterprise)).
- Cache the result per session. Re-read on `/clear` and on a changed `cwd` (*inference*).

When it is null (no repo, or `remote: null`, or an unparsable URL): a bare `#N` has no home. Options for the user: ignore bare `#N`; keep it as "unresolved `#N`" with no link and no enrichment; or ask `gh` in the session's cwd (`gh repo view --json nameWithOwner`; needs network and login). *inference*

Fork caveat (*inference*): `origin` may be a fork while the person means the upstream issue. `gh pr view N` in the cwd uses `gh`'s own default repo logic. Let `gh` return the canonical `url` field and use that as the item key when enrichment works.

## 5. Background refresh and timers

`$.clock` ([d.ts:3426](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L3426)): `now()`, `sleep(ms)`, `after(ms, fn) => { cancel }`, `every(ms, fn) => { cancel }`. A timer's callback is the plugin's own function, run in its environment. A hot reload cancels pending waits ([d.ts:3418-3425](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L3418), [TimerCall d.ts:12626](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L12626)). *primary*

The hook budget is 10 s of the hook's own code; `$` calls do not count ([HookBudget d.ts:5100](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L5100)). The types say nothing on a budget for a timer callback. So it was measured.

| Check | Result | Tag |
| --- | --- | --- |
| Callback calls `$.process.run` then `update($, atom, ...)` | Works (`gh --version`, 36 ms then state written). | *observed* ([timers.json](sources/live-observations-2026-10-10/outputs/timers.json) T1) |
| Callback that runs 12 s | `process.run(['sleep','12'])` finished in 12,011 ms and wrote state. | *observed* (T3) |
| Callback with `$.clock.sleep(11000)` | Finished in 11,002 ms. `sleep` counts against a hook budget, not against a timer. | *observed* (T4) |
| Callback that runs 45 s | Finished in 45,004 ms and wrote state. | *observed* ([t2-end.json](sources/live-observations-2026-10-10/outputs/t2-end.json) T7) |
| Callback that throws | Log line `[WARN] probe: $.clock.after: the callback threw: T5 boom`. Other timers kept running. | *observed* ([debug-excerpts.txt](sources/live-observations-2026-10-10/outputs/debug-excerpts.txt)) |
| `every(1000)` with a 2,500 ms callback | Callbacks **overlap**. A new one starts each second. The engine does not wait. | *observed* ([t2-mid.json](sources/live-observations-2026-10-10/outputs/t2-mid.json) T8) |
| `$.store.set` / `get` in a callback | Works. | *observed* (T6) |
| `$` captured in a hook, used by a timer long after the hook returned | Works. | *observed* |
| `/clear` | Timers keep running (the heartbeat went 12, 16, 18). Module variables survive. `$.state` resets (`ticks: 0`, empty log). `$.session.id()` changes. `session.start` is not raised again. | *observed* ([heartbeat-timeline.txt](sources/live-observations-2026-10-10/outputs/heartbeat-timeline.txt), [after-clear.json](sources/live-observations-2026-10-10/outputs/after-clear.json)) |
| Hot reload (a file in the `--plugin-dir` folder changed) | `register` runs again, `session.start` is raised again (`session.start: raised for probe (loaded later)`), module variables reset, old timers are gone (no double beat), `$.state` is kept (`ticks: 3`, 6 entries before and after). | *observed* ([state-after-reload.json](sources/live-observations-2026-10-10/outputs/state-after-reload.json)) |
| `-p "/cmd"` run | The process ends when the command ends. A timer started there has no time to fire. | *inference* |

The rule "a `ui.render` hook cannot write `$.state`" holds ([d.ts:3416](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L3416), [gotcha 24](../claude-code-mods/gotchas.md)). So refresh results go to `$.state` from a timer callback, a command hook, or a `session.append`/`prompt.submit` hook. *Observed* that a timer write redraws an open pane (section 6).

Design consequences (*inference*):

- A refresh scheduler is one `$.clock.every` (or a chain of `after`) started in `session.start`. It needs a **re-entry guard** (`if (busy) return`) because `every` does not wait.
- Start it again after a hot reload: `session.start` is raised again, so the same code path does it. Make it idempotent with a module variable that resets on reload (the old timers are gone anyway).
- Timers are not lost on `/clear`. The scheduler must read the **current** list from `$.state` each run, not a captured copy.
- Cancel the timer when no item can refresh (all tools missing).
- Keep each tool call under its own `timeoutMs` (the 30 s default is fine). The circuit breaker belongs around `run`, not around the timer.

## 6. The pane

### Open and seating

`$.ui.open({ id, title?, focus?, closeOnEscape?, holdToasts?, rows?, columns? })` resolves `{ isPlaced: true }` or `{ isPlaced: false, reason }` ([d.ts:2500](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L2500), [PaneOpenArgs d.ts:7390](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L7390), [UiOpenResult d.ts:14134](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L14134)). Details: [mods ui.md §3](../claude-code-mods/reference/ui.md). *primary*

| Check | Result | Tag |
| --- | --- | --- |
| Opened by a command the person typed, 100 columns | `{ isPlaced: true }`. Seated **inline**. | *observed* ([r2-pane-100.txt](sources/live-observations-2026-10-10/outputs/screens/r2-pane-100.txt)) |
| Opened by a timer, 100 columns | `{ isPlaced: false, reason: "unasked below 110 columns (100 now, an id the person opened before): placed when the person opens it, or when the terminal is widened to 110 columns" }`. The floor was 110 because the config dir remembered the id from an earlier run. A fresh id has a 144 floor. | *observed* ([pane-open-c100.json](sources/live-observations-2026-10-10/outputs/pane-open-c100.json)), *primary* |
| 140 columns, 40 rows | `placement: 'dock'`, `bodyColumns: 62`, `viewport.columns: 77`, `scroll.bodyRows: 34`. | *observed* ([render-props-77.json](sources/live-observations-2026-10-10/outputs/render-props-77.json)) |
| 100 columns, 40 rows | `placement: 'inline'`, `bodyColumns: 96`, `scroll.bodyRows: 11`. | *observed* ([render-props-100.json](sources/live-observations-2026-10-10/outputs/render-props-100.json)) |

Rules: open from `/track` (the person asked), size the tree by `e.props.bodyColumns`, and read `isPlaced`. Both runs had `viewport.isFullscreen: true`. A non-fullscreen terminal was not tried. *Inference*: the dock needs fullscreen.

### Redraw when state changes

An atom read inside the `ui.render` hook subscribes the instance. A later `$.state.set` redraws it. Nobody calls `$.ui.invalidate` ([d.ts:3384](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L3384), [state-and-storage](../claude-code-mods/concepts/state-and-storage.md)). *primary*

*Observed* live: a row written by a `$.clock.after` callback appeared in the open pane, and so did one written by a command hook ([r1-pane-after-cmd.txt](sources/live-observations-2026-10-10/outputs/screens/r1-pane-after-cmd.txt)). *Observed* in the kit: `ui.find` sees the new row after `$.command.run` and after `clock.advance` (`probe.test.tsx`, both surfaces).

`$.ui.invalidate('ui.render')` re-runs the render for state that is **not** in `$.state` (a module variable). Limits: 10 a second, 30 for the shown pane in the terminal; faster calls fold ([d.ts:2348-2360](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L2348)). The `$.state` redraw is throttled the same way ([reference.md:118](../claude-code-mods/sources/claude-code-2.1.295/reference.md#L118)). Do not write state in a tight loop; batch one `update` per refresh round.

### Tree table with `Box` and `Text`

`Text` has **no width prop** ([TextProps d.ts:12563](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L12563)). Put the width on a `Box` cell ([BoxProps d.ts:901](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L901)): `width`, `minWidth`, `flexGrow`, `flexShrink`, `columnGap`, `paddingLeft`. `Text wrap` takes `wrap`, `truncate-end` (draws `…`), `truncate-start`, `truncate-middle`, `end`, `middle`, `truncate`. *primary*

Verified layout ([screen](sources/live-observations-2026-10-10/outputs/screens/r3-pane-v2.txt), code in [`register.tsx`](sources/live-observations-2026-10-10/probe-mod/hooks/register.tsx)):

```tsx
<Box flexDirection="column">
  <Box columnGap={1}>                                   {/* header */}
    <Box width={14}><Text bold>Item</Text></Box>
    <Box flexGrow={1} flexShrink={1}><Text bold wrap="truncate-end">Title</Text></Box>
    <Box width={8}><Text bold>Type</Text></Box>
    <Box width={12}><Text bold>Status</Text></Box>
  </Box>
  {rows.map(r => (
    <Box key={'row-' + r.id} columnGap={1}>
      <Box width={14} flexShrink={0} paddingLeft={r.depth * 2}>        {/* indent = tree depth */}
        <Box width={2} flexShrink={0}>
          {r.hasKids ? <Button key={'t-' + r.id} plain label={closed.includes(r.id) ? '+' : '-'}
                               onPress={() => update($, collapsed, toggle(r.id))} /> : <Text> </Text>}
        </Box>
        <Text wrap="truncate-end">{r.id}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {r.href ? <Text wrap="truncate-end"><Link href={r.href}>{r.title}</Link></Text>
                : <Text wrap="truncate-end">{r.title}</Text>}
      </Box>
      <Box width={8} flexShrink={0}><Text wrap="truncate-end">{r.type}</Text></Box>
      <Box width={12} flexShrink={0}><Text wrap="truncate-end" dimColor>{r.status}</Text></Box>
    </Box>
  ))}
</Box>
```

What the live run showed:

- First layout had no `columnGap`: a truncated title ran into the next column (`…story in-prog…`). Add `columnGap={1}`.
- A `Button` with children inside a fixed-width cell shifted the next column. Use a separate fixed `Box` for the toggle (`Button plain label="-"`).
- The title column shrinks with the pane (62 columns docked, 96 inline) and ends in `…`.
- Collapsible rows: keep the collapsed ids in a `$.state` atom. `onPress` calls `update` ([Button d.ts:1060](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L1060)). The kit pressed `t-J1`, the children vanished, a second press brought them back (both `terminal` and `desktop`). The keyboard path (ctrl+x Tab, Enter) was **not** verified live.
- Give every `Button` a stable `key`. A `Button` takes string or `Text` children only ([ui.md §6](../claude-code-mods/reference/ui.md)).
- Walk the tree in the hook to skip the children of a collapsed row. Only draw what fits (`e.props.scroll.bodyRows`).

### `Link`

`<Link href label?>` ([LinkProps d.ts:5642](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L5642)): inline element. Children are the text. `href` may use any scheme and is at most 2,048 characters once percent-encoded. A blank or non-string `href` draws plain text and the tree stands. On a **remote** surface anything but `https:` draws plain. The terminal draws an OSC 8 span, else the text then the URL in dim. A click opens what the terminal opens. *primary*

*Observed* (pty, `FORCE_HYPERLINK=1`): `<Text><Link href=…>A pull request</Link></Text>` in a pane emitted `ESC ] 8 ; id=… ; https://github.com/o/r/pull/1 BEL A pull request … ESC ] 8 ; ; BEL` ([link-osc8-excerpt.txt](sources/live-observations-2026-10-10/outputs/link-osc8-excerpt.txt)). The `Link` mounted in the kit on `terminal` and `desktop`. The mod does not see clicks on a `Link`. A click-count or in-mod open needs `Markdown` with `onLinkPress` ([ui.md §9](../claude-code-mods/reference/ui.md)). Use `https:` URLs only for Jira and GitHub; that is valid on every surface.

### Size bounds

- **20,000 nodes, 32 deep, 100,000 serialized characters** is the bound for a `Client` surface module's tree ([d.ts:1406](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L1406)). The mods KB [ui.md §10](../claude-code-mods/reference/ui.md) attributes it to `Client` too. It is **not** stated for an ordinary `ui.render` tree. *primary*
- For an ordinary tree [reference.md:130](../claude-code-mods/sources/claude-code-2.1.295/reference.md#L130) says: the first **100,000 characters** of the tree's texts are drawn and the cut text ends with words saying how much is left out. A `Link` (by its address) or a `Client` that does not fit in that room draws nothing. A `Link` address is held to 2,048. No node-count bound is stated (*open*, see the end).
- A tree that does not validate is not drawn. The engine draws its own, and only the debug log says why ([gotcha 27](../claude-code-mods/gotchas.md)). Run the live mod with `--debug-file`.

## 7. Commands

`$.command.register({ name, description, argumentHint?, immediate? })` in `session.start`. It lists `/name` in the typeahead from the next keystroke ([CommandSpec d.ts:1886](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L1886), [d.ts:3091](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L3091)). Serve it with `on('command.run', { command: 'track' }, ...)`. The hook gets `e.args` (everything after the name as typed) and `e.origin`, and returns `{ text?, context?, exitCode? }` ([CommandRunInput d.ts:1792](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L1792), [CommandRunResult d.ts:1837](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L1837)). *primary*, *observed* (all ten probe commands).

```ts
on('session.start', async ($, e, next) => {
  await $.command.register({ name: 'track', description: 'Open the tracking pane', argumentHint: '[refresh|clear]' })
  return next(e)
})
on('command.run', { command: 'track' }, async ($, e) => {
  const sub = e.args.trim()
  if (sub === 'refresh') { void refreshAll($); return { text: 'Refresh started.' } }   // do not await long work
  const opened = await $.ui.open({ id: 'tracking', title: 'Tracking' })
  return { text: opened.isPlaced ? 'Tracking pane opened.' : 'The pane waits for a wider terminal.' }
})
```

Notes:

- A `$.ui.open` inside a command the person typed is **asked**: it was placed at 100 columns (*observed*).
- `text` is printed as a transcript row **and the model reads it** ([CommandOutput, ui.md §2](../claude-code-mods/reference/ui.md)). Keep it one line. Use `context` for text only the model should see. *primary*
- The command also appears as `session.append` rows with door `command`, origin `engine` (two rows, with `<command-args>`). Do not scan them (section 3).
- `-p "/track refresh"` works headless (*observed* with `-p "/probe-run"`). *Inference*: the process then exits when the command ends, so a background refresh would be cut. For `-p`, await the refresh.
- A `command.run` hook's budget is 10 s of its own code; `$` calls do not count. Awaiting `gh` calls inside the hook is allowed, but the command output waits for them.
- Registering a name again replaces it. `session.start` re-fires on a hot reload, so registration is idempotent. A built-in name is refused.
- In the kit: `$.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })` ([testing-kit](../claude-code-mods/reference/testing-kit.md)).

## 8. State, store and restore

**Contract.** `types/index.d.ts` merges into `PluginState` and `plugin.json` names it (`"types"`). Every `$.state` key must be declared. `atom({ plugin, key } as const, init)` needs literal `plugin` and `key` ([state-and-storage](../claude-code-mods/concepts/state-and-storage.md), [PluginState d.ts:7786](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L7786)). Values must be JSON. A class instance is **not** JSON: keep plain records in `$.state` and build `TrackedItem` objects from them (or keep the objects in a module variable and mirror plain data). *inference*

Suggested contract (*inference*):

```ts
export type ItemRecord = { id: string; kind: 'github' | 'jira' | 'web'; url: string; title?: string; type?: string; status?: string; checks?: string; parent?: string; seen: number; source: 'prompt' | 'response' | 'tool'; refreshedAt?: number; failures?: number }
declare module 'claude-code' { interface PluginState { 'artifact-tracking': { items: ItemRecord[]; collapsed: string[] } } }
```

| Store | Limit or rule | Source |
| --- | --- | --- |
| `$.state` | Versioned JSON, survives hot reload, reset by `/clear`, `/resume`, `/branch`. Use `update`, never write a captured copy. | [state-and-storage](../claude-code-mods/concepts/state-and-storage.md); reset after `/clear` *observed* |
| `$.store` | JSON file per plugin under the config dir. **4 MiB in all**, shared by every session on the machine. `get` then `set` is not atomic. `set` rejects a function, a cycle, or an over-limit store. | [d.ts:3351](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L3351) |

**Restore approach to copy** from [link-capture `register.ts`](../claude-code-link-capture/example/link-capture/hooks/register.ts):

1. Working list in `$.state`; mirror in `$.store` under `s:<sessionId>` plus an `index` of the newest 20 sessions ([flush, L48](../claude-code-link-capture/example/link-capture/hooks/register.ts#L48)). Write the mirror from one `$.clock.after(1500)` per burst, not per change. Never write an empty list over a stored one.
2. `ensure($)` at the top of every hook: compare `await $.session.id()` with a module variable. A change means `/clear`, `/resume` or `/branch`, so call `restore` ([ensure, L92](../claude-code-link-capture/example/link-capture/hooks/register.ts#L92)). *Observed* here: after `/clear` the session id changed and `session.start` did not fire again.
3. `restore`: if `$.state` already has items, stop (a hot reload keeps it). Else backfill from `$.session.messages()` (a `--resume` load fires no appends), then from the `$.store` copy ([restore, L66](../claude-code-link-capture/example/link-capture/hooks/register.ts#L66)).
4. Do not rely on `classic.SessionStart` for this. It did not run for a user mod on that machine ([link-capture rule 13](../claude-code-link-capture/README.md)).
5. Cap the list. *Inference*: an item is small (a few hundred bytes), so 500 items per session and 20 sessions stay far below 4 MiB. Subtask trees from `acli` add more rows; cap them too.

Decision for the user: after `/clear`, should the tracker keep the old items (link-capture did) or start empty? See D10 in [open-questions](open-questions.md#4-decisions-for-the-user).

## 9. Gotchas that bite this design

### `$` must not cross a call (verified)

`claude plugin validate` reads `$` by source. Ten variants, same result on 2.1.295 and 2.1.296 ([validate output](sources/live-observations-2026-10-10/outputs/validate.2.1.295.txt), [sources](sources/live-observations-2026-10-10/validate-variants/)):

| Variant | Spelling | Result |
| --- | --- | --- |
| v1 | `new GhTool((argv) => $.process.run(argv))`, class from `./tools` | **pass** (`calls: $.process.run`) |
| v8 | the same, stored in a module variable, used from a `$.clock.after` callback | **pass** |
| v10 | top-level `function runnerOf($) { return (argv) => $.process.run(argv) }` in `register.ts`, result passed to the class | **pass** (`$.process.run (via runnerOf)`) |
| v2 | `probe($)`, `probe` imported from `./helper` | fail: `$ is followed only into a function declared in this same file, never across an import` |
| v3 | `new Thing($)`, class imported | fail: `$ itself is passed as an argument` |
| v5 | `new Item().refresh($)`, class **in the same file** | fail: same message. A method is not followed. |
| v6 | `held = $` (module variable) | fail: `$ itself is assigned` |
| v4 | `const p = $.process` | fail: `$.process is used as a value` |
| v7 | `const run = $.process.run` | fail: `$.process.run is used as a value ... instead of called` |
| v9 | two `on('session.append', fn)` with no matcher | fail: `registered twice without a matcher` |

So **inject a plain function**. In `register.ts`:

```ts
const run: Run = (argv, init) => $.process.run(argv, init)   // $ appears only as $.noun.event(...)
const now = () => $.clock.now()
const gh = new GhTool(run)                                    // class from ./tools.ts, no $ inside
```

*Observed live* (`-p "/probe-avail"`): the `Availability` class built with such a closure in `session.start` was used by a later `command.run` and by timers.

### Classes, modules, globals

- Classes in the mod's own files are fine. `import` between own files by relative path is fine. No `import()`, no `require`, no bare package imports ([gotcha 2](../claude-code-mods/gotchas.md)). An abstract class and `protected` constructor parameters pass `validate` (v1). A class with constructor parameter properties (`Availability`) ran live. *observed*
- Module variables are lost on hot reload; `$.state` and `$.store` are not ([section 5](#5-background-refresh-and-timers)). The circuit-breaker counters are module variables, so a reload resets them. Mirror them in `$.state` if that matters. *inference*
- Globals in the hooks module (*observed*, [probe-globals.txt](sources/live-observations-2026-10-10/outputs/probe-globals.txt)): present `Date`, `URL`, `URLSearchParams`, `Intl`, `TextEncoder`, `structuredClone`, `AbortController`, `setTimeout`, `setInterval`, `crypto`, `console`, `Map`, `Set`, `BigInt`. Absent: `fetch`, `process`, `require`, `Buffer`, `queueMicrotask`, `WeakRef`. `new URL(...)` parsed a Jira URL. A look-behind regex `(?<![\w/])#(\d+)\b` worked. Prefer `$.clock` for time and timers so the kit can mock them.
- One hook per matcher: a second `on('session.append', fn)` with no matcher fails the load (v9, [gotcha 5](../claude-code-mods/gotchas.md)). Use `{ door }` matchers. A `command.run` hook with no matcher beside hooks with a matcher was accepted (*observed*). It saw `/foo` but not the commands the plugin's own matcher hooks answered (`/probe-repo`). Why is *inference*: the answering hook does not call `next`.
- Every observe-only `session.append` hook: call `next(e)` first, return its result unchanged, add `.catch(($, e, next) => next(e))` ([link-capture rules 2, 3](../claude-code-link-capture/README.md)). `validate` prints "gating hook without .catch" otherwise.
- `{ deny }` from a stub makes the mod's `$` call reject. Real `$.process.run` also rejects on start failure. Wrap every call in `try/catch` in the `Tool` layer and turn it into a typed result for the circuit breaker.
- `tsc` was not run on the probe mod. No `tsc` is installed on this machine, and the KB's recipe uses `npx -y`, which installs. The kit tests cast with `as never` in two places, so a props-shape error would not show. Run the KB's [`tsconfig`](../claude-code-link-capture/example/tsconfig.json) pattern before the real mod.

## Design recommendations (from the API facts)

1. `register.ts` is the only file with `$`. It builds `run`, `now`, `store` adapters as closures and hands them to classes in other files.
2. `Tool` takes `run`. `TrackedItem.refresh()` takes a `Tool` (or the item holds one). `canRefresh()` reads a cached, async-filled availability flag.
3. The `CircuitBreaker` wraps `run`: count rejections and non-zero exits per tool, open after N, close after a cooldown measured with `now()`.
4. The scheduler is one `$.clock.every` with a re-entry guard. It reads `$.state` each round and writes with `update`.
5. Capture hooks: `session.append` `response` (Claude), `session.append` `prompt` or `prompt.submit` (person), optionally `tool-result` for explicit URLs. Observe-only.
6. The pane reads atoms. No `$.ui.invalidate` needed.
7. Tests: plain tests with a fake `run` for classes. Kit tests for wiring, with `on('process.run', ...)` stubs, `mock.clock`, and `ui.mount` for the pane.

## Decisions and open points

The decisions for the user (D1 to D18) and the open points (N1 to N21, conflict C1) are in [open-questions.md](open-questions.md).
