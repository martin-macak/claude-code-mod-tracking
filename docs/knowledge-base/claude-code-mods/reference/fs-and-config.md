# File system and config files

What `$.fs` can do, what it cannot do, and how it behaves on a real machine and in the test kit. Use it to read and write a file outside the plugin, such as a config file under `~/.config`.

Pinned to Claude Code **2.1.302**. Links go to the [2.1.302 types](../sources/claude-code-2.1.302/types/claude-code.d.ts). The `$.fs`, `$.store` and `$.state` blocks are byte-identical to 2.1.295 (new anchors; old ones are 83 lines earlier).

Grades on a claim:

- *verified-live*: seen in a real interactive session (tmux, `claude --plugin-dir`).
- *verified-kit*: seen in `claude plugin validate` or `claude plugin test`.
- *types-only*: the d.ts says it. Nobody ran it.
- *inference*: no source says it.

The spikes are throwaway mods built for [issue #55](https://github.com/martin-macak/claude-code-mod-tracking/issues/55). Their source is in [spikes-2026-10-17](../sources/spikes-2026-10-17/README.md) (`life-spike`, `kit-fs`). Each claim quotes what it saw.

## The calls

| Call | Does | Anchor |
| --- | --- | --- |
| `$.fs.read(path, { as? })` | The file's text, or `{ base64 }` with `as: 'bytes'`. Rejects when the file is missing or over 4 MiB. | [d.ts:3308](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3308) |
| `$.fs.write(path, text)` | Writes the whole text. Creates the file **and its directories**. Takes no mode. | [d.ts:3327](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3327) |
| `$.fs.list(path?)` | `{ name, kind, size, mtimeMs, isLink }` per entry. `size` and `mtimeMs` are 0 for anything but a regular file. | [d.ts:3333](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3333) |
| `$.fs.exists(path)` | `boolean`. Rejects only for a network location. | [d.ts:3348](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3348) |
| `$.fs.stat(path, { resolve? })` | `{ kind, size, mtimeMs, isLink }`, with `realPath` when asked. Rejects `ENOENT` for a missing path. | [d.ts:3353](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3353) |
| `$.fs.ancestors(request)` | Reads named instruction files above the original cwd, like `CLAUDE.md`. | [d.ts:3406](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3406) |

All are *types-only* for their shapes. Types: [`FsEntry`](../sources/claude-code-2.1.302/types/claude-code.d.ts#L5057), [`FsStat`](../sources/claude-code-2.1.302/types/claude-code.d.ts#L5129).

## Scope and paths

- `$.fs` is "the file system as the engine's own process reaches it". A relative path is under the session's working directory. Text is UTF-8. ([d.ts:3299](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3299), types-only)
- An absolute path is used as given. Where one may go is an `fs.*` hook's to say. ([d.ts:3302](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3302), types-only)
- **`~` is not documented as expanded.** The `$.fs` text says only "an absolute path is used as given". The `stat` doc lists `~` among the spellings the engine cannot resolve to a `realPath`, "a spelling it cannot resolve (`~`, a file not there yet) the tool may open". That sentence is about a guard that checks a tool's path. It is not about `$.fs.write`. ([d.ts:3358](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3358), types-only, plus *inference*) Nobody ran `$.fs.write('~/x', …)`. Build the path from `HOME`.
- Read `HOME` with a **literal** name: `await $.env.get('HOME')`. `validate` lists it as `env reads: HOME`. A computed name does not load. ([d.ts:3671](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3671), [d.ts:7887](../sources/claude-code-2.1.302/types/claude-code.d.ts#L7887), types-only) *verified-live:* `$.env.get('HOME')` returned the user's home directory. *verified-kit:* `$.env.get('HOME')` and `$.env.get('XDG_CONFIG_HOME')` inside closures built by one top-level `portsOf($)` pass `validate`: `calls: $.env.get (via portsOf)` and `env reads: HOME, XDG_CONFIG_HOME` (scratch spike, 2.1.302, validate only).
- A file the plugin ships is under `$.plugin.root`. ([d.ts:3312](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3312), types-only)
- If you want `XDG_CONFIG_HOME`, read it by its own literal name. The reader lists each name. *Inference.*

## Limits

- A read or a write over **4 MiB** rejects. ([d.ts:3303](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3303), types-only)
- The layer beneath the hooks rejects a network location untouched. An OS refusal rejects with its errno. ([d.ts:3304](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3304), types-only)
- **No delete, no rename, no mkdir, no append, no chmod, no lock, no watch.** The block has none of them. ([d.ts:3306-3425](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3306), types-only) So there is no atomic replace, no cross-process safety and no change notification. `$.process.run(['rm', …])` is a different noun with its own entry in `uses.calls`. ([d.ts:7894](../sources/claude-code-2.1.302/types/claude-code.d.ts#L7894))
- `write` takes no file mode. `FsStat` has no mode field either. Keep secrets out of a file you write this way. *Inference.*
- `$.fs.list` gives 0 for `size` and `mtimeMs` of a directory. `$.fs.stat(dir)` gives real values. *verified-live:* `stat(dir)` answered `kind: 'dir'`, `size: 128`.

## Every call is an event

- Each `$.fs` call is an event: `fs.read`, `fs.write`, `fs.list`, `fs.exists`, `fs.stat`, `fs.ancestors`. A hook above the plugin can rewrite the call or deny it. ([d.ts:7205](../sources/claude-code-2.1.302/types/claude-code.d.ts#L7205), results at [d.ts:7433](../sources/claude-code-2.1.302/types/claude-code.d.ts#L7433), types-only)
- `validate` lists the call as `calls: $.fs.read, $.fs.write, …`. A managed `plugin.register` policy reads the same list and may refuse a module that calls `fs.write`. ([d.ts:7887](../sources/claude-code-2.1.302/types/claude-code.d.ts#L7887), types-only)
- Another plugin's `fs.*` hook can therefore make your file I/O fail. Handle a rejection from every call.

## Live under `~/.config`

*verified-live,* Claude Code 2.1.302, tmux, `claude --plugin-dir <spike> --setting-sources project`. A command in the spike ran each call on `$HOME/.config/claude-code/mods/tracker-spike/`.

| Call | Result |
| --- | --- |
| `exists(dir)`, `exists(file)` before anything | `false`, `false` |
| `write(file)` | `ok (2 ms)`. Created `~/.config/claude-code` and `mods`, which did not exist before. |
| `exists(file)`, then `read(file)` | `true`, then the text. The read equalled what was written. |
| `stat(file)` | `{ kind: 'file', size: 22, mtimeMs: 1792230999936.3071, isLink: false }` |
| `list(dir)` | ok |
| `write` to a path two directories deeper | ok. The directories were made. |

- **No permission prompt, no deny, no hot-reload question.** This held in manual mode and in auto mode, and on a directory that did not exist.
- The same hooks module also wrote files under the system temp folder, outside the session's cwd. No prompt. A second run (`lifecycle-mod`, auto mode) wrote there too and raised no prompt.
- The scope of the test: an interactive session, default and auto permission modes, no other mod, no managed settings file on the machine. A `claude -p` run was not tried.
- A write outside the dev-mods folder does not raise the "Enable hot reloading" question. That question is about files under the session's mods folder only.
- *verified-live:* `$.fs.write` worked from a `ui.render` hook too, with no prompt. It is not a `$.state` write, so the render rule does not apply. It makes a handy probe.

## Torn reads and `mtime`

`$.fs.write` overwrites **in place**. It is not a temp file plus rename. *verified-live,* macOS APFS:

- The inode stayed the same over 21 or more writes (`stat -f %i`).
- Large files tear. A reader that reads while a 1 MiB file is overwritten can see old and new text mixed.

| Reader | Writes | Result |
| --- | --- | --- |
| `$.fs.read` in a hot loop, same process | 1 MiB, same size | 72 to 79 percent of reads mixed old and new |
| `$.fs.read` in a hot loop, same process | 1 MiB and 4 KiB alternately | 81 percent of reads had a length that was neither size |
| External reader, one `read(2)` | 1 MiB, same size | 93,325 reads, none mixed |
| External reader, 64 KiB chunks | 1 MiB, same size | 2.3 percent mixed |
| External reader, 64 KiB chunks | 1 MiB and 4 KiB alternately | partial lengths in multiples of 64 KiB |
| External readers, 4 KiB content | 4 KiB | about 200,000 reads, none mixed |

- No reader saw an empty file. About 350,000 external reads, zero empty.
- The small-file result is from an external reader. The in-process `$.fs.read` of a small file was not measured.
- `$.fs.stat().mtimeMs` is a float with sub-millisecond resolution. Ten back-to-back writes gave ten distinct values about 0.3 ms apart. `$.clock.now()` and `mtimeMs` agreed within 1 ms. The tests ran on APFS. Other filesystems were not tested. ([d.ts:5140](../sources/claude-code-2.1.302/types/claude-code.d.ts#L5140) says only "milliseconds since the epoch".)
- Two sessions writing one file were not tested. There is no lock and no compare-and-set, so the last writer wins. *Inference.*

## In the test kit

*verified-kit,* `claude plugin test`, 2.1.302. Spike [`kit-fs`](../sources/spikes-2026-10-17/kit-fs/).

- An **unstubbed** `$.fs.read`, `write` or `exists` is refused with `no implementation for fs.<op>`. It never reaches the disk. A file that exists on disk is not read. A write creates nothing. This holds for a path under `$.plugin.root` too.
- The test body has no `fs` noun. `$.fs` is `undefined` there, and `tsc` says `Property 'fs' does not exist on type 'Engine'`. Drive file I/O through a command or hook of the mod.
- `claude-code/testing` has `mock` for `clock`, `store`, `env` and `session`. It has no `mock.fs`. ([d.ts:16158](../sources/claude-code-2.1.302/types/claude-code.d.ts#L16158), types-only) Stub the events instead.
- The stub pattern. A `Map` plays the disk. A stub returns `{ value }` or `{ deny }`:

  ```ts
  const DIR = '/abs/scratch/dir'   // any absolute path; the stub answers it, the disk is never touched
  const disk = new Map<string, string>([[`${DIR}/cfg.json`, '{"a":1}']])
  on('fs.exists', (_$, e) => ({ value: disk.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = disk.get(e.path)
    if (text === undefined) return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
    return { value: text }
  })
  on('fs.write', (_$, e) => { disk.set(e.path, e.text); return { value: undefined } })
  ```

- The mod sees a deny as a rejection: `kit-fs: $.fs.read: ENOENT: no such file or directory, open …` and `kit-fs: $.fs.write: EACCES: permission denied`. `e.as` is `'text'` unless the mod asked for bytes.
- A **bare** value stub fails the test. `on('fs.exists', () => true)` gives `returned something that is not a result object` and `test's fs.exists hook was skipped`. The mod meanwhile got `no implementation for fs.exists`. The 2.1.295 wording was `returned neither { value } nor { deny }`.
- This repo's own `world()` fixture stubs only `fs.stat` (`plugins/artifact-tracking/tests/fixtures/world.ts`). A class that takes an `FsPort` needs no kit at all. Fake the port with a `Map`.

## Not the same as `$.store`

- `$.store` is a JSON file of the plugin's own, in the user's Claude Code configuration directory. It holds JSON only, 4 MiB in all. ([d.ts:3428](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3428), [d.ts:3447](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3447), types-only)
- It is **not** `~/.config/claude-code/mods/…`. On this machine the config directory is `~/.claude-personal`.
- *verified-live,* one machine: the store file name carries the plugin and its provenance, as `<name>_<provenance>-<hash>.json`, for example `life-spike_inline-cd72fb26cb19.json`, mode 0600. A `--plugin-dir` run (`inline`), a skills-folder copy and an installed copy of one plugin are separate stores. Data written in a dev run is not there in the installed copy.
- A file under `~/.config` is shared by every session and every provenance. That is its use. It is also its risk.

## What follows for a config file

*Inference* from the facts above. The design lives in the architecture work, not here.

- Treat a read as untrusted. Parse the whole text. On a parse error, retry once, then keep the last good value.
- Keep the file small. Under 4 KiB no tear was seen.
- Write the whole file each time. Skip the write when the text did not change.
- Cache by `mtimeMs` and `size` together, with equality. Do not use "greater than".
- Never expect a delete or a rename. Never rely on a lock.
- Call `$.env.get('HOME')` once with a literal name. Do not use `~`.
- In tests, fake the port in memory or stub `fs.*` on the kit's `on`.

## Not tested

- A `$.fs` call from a `claude -p` run, a subagent hook, or an installed (not `--plugin-dir`) plugin.
- `~` as a path.
- Two live sessions on one small config file.
- `mtimeMs` resolution on HFS+, network home directories, ext4 and tmpfs.
- What file mode a new file and directory get.
- Whether `session.end` aborts an in-flight `$.fs.write` at the 1.5 s bound ([lifecycle](../concepts/lifecycle.md#session-end-and-the-15-s-bound)).

## See also

- [engine-interface](engine-interface.md): all `$` nouns.
- [testing-kit](testing-kit.md): `mock`, stubs and the kit's limits.
- [state-and-storage](../concepts/state-and-storage.md): `$.state` and `$.store`.
- [ports-and-injection](../concepts/ports-and-injection.md): hand `$.fs` on as a port.
