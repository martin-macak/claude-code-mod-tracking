# Sources

Verbatim snapshots of primary sources. Do not edit them.

## `claude-code-2.1.295/`

Captured on 2026-10-09 from Claude Code 2.1.295 (macOS).

| File | Origin |
| --- | --- |
| `SKILL.md` | Body of the bundled `plugin-authoring` skill. The skill has no file on disk; the text was copied from the loaded skill. Session paths are replaced with `<MODS_DIR>` and `<SKILL_DIR>`. |
| `reference.md` | `<SKILL_DIR>/reference.md`, the skill's long form. Absolute temp paths are made relative. |
| `examples/` | `<SKILL_DIR>/examples/`: three complete hooks modules and two state contracts. |
| `types/claude-code.d.ts` | `<SKILL_DIR>/types/claude-code.d.ts`, the engine-written API declarations (21,451 lines). |
| `cli-help.txt` | Output of `claude plugin --help` and its `validate`, `test`, `init`, `details`, `configure` subcommands. |

`<SKILL_DIR>` was `/private/tmp/claude-501/bundled-skills/<version>/<hash>/plugin-authoring`. The engine writes it when the skill loads. It is temporary.

### Known discrepancies

- `SKILL.md` says the API file is "about 14,000 lines". The snapshot has 21,451 lines.

### Not captured yet

Once the engine loads a mod from a watched folder, it writes `<mod>/.claude-plugin/types/` with `claude-code/index.d.ts`, `claude-code-tools/index.d.ts` (this machine's built-in tools), `claude-code-mcp/index.d.ts` (connected MCP tools) and a `tsconfig.json`. Snapshot the tools and MCP files when the first mod loads.

## `claude-code-2.1.302/`

Captured on 2026-10-17 from Claude Code 2.1.302 (macOS). Same layout as the 2.1.295 folder. Made by the refresh procedure below.

| File | Origin |
| --- | --- |
| `SKILL.md` | Body of the bundled `plugin-authoring` skill, with `<MODS_DIR>` and `<SKILL_DIR>` in place of session paths. It adds a "SHARING IT" paragraph (line 25). |
| `reference.md` | `<SKILL_DIR>/reference.md`. It holds no absolute temp path (a search for `/private/tmp`, `bundled-skills` and `/Users/` finds none), so the path replacement changed nothing. |
| `examples/` | The same three hooks modules and two state contracts. `diff -r` against 2.1.295 shows nothing. |
| `types/claude-code.d.ts` | The engine-written API declarations (22,255 lines; 2.1.295 has 21,451). |
| `cli-help.txt` | Output of `claude plugin --help` and its `validate`, `test`, `init`, `details`, `configure` subcommands. Byte-identical to the 2.1.295 file. |

What changed, as far as a mod author needs: [reference/changes-2.1.302](../reference/changes-2.1.302.md).

### Known discrepancies in 2.1.302

- `SKILL.md` still says the API file is "about 14,000 lines". The snapshot has 22,255 lines. (The 2.1.295 file said it too.)
- `reference.md` line 168 still says a record queued by a plugin's own `$.prompt.submit` or `$.command.run` is raised under the hook's frames, "so that hook is not run on it (the re-entry rule)". The sentence is right about the behaviour: a plugin's call runs the chain with the calling hook alone skipped (`d.ts` 4843-4844, *verified-kit*, see [dispatch-and-guards](../concepts/dispatch-and-guards.md#a-hook-is-not-run-beneath-its-own-call)). Only the name is old: `HookFailure.kind` is `'throw' | 'timeout'` now, and the `re-entry` failure kind, the `lent` cause and the ten-second re-ask are gone from `reference.md` line 79 and from the types.

## `spikes-2026-10-17/`

Captured on 2026-10-17 and 2026-10-18 from the throwaway spike mods of [issue #55](https://github.com/martin-macak/claude-code-mod-tracking/issues/55), Claude Code 2.1.302 (macOS). Not a primary source: it is the evidence behind the graded claims in the 2.1.302 pages and in the [mod-architecture KB](../../claude-code-mod-architecture/README.md).

| Content | Origin |
| --- | --- |
| One folder per spike (84) | Only its source: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/**/*.ts(x)`, `tests/*.ts`, `types/index.d.ts`, `core/` and `trackers/`. No `node_modules`, no `.claude-plugin/types/`, no copied engine `claude-code.d.ts`. |
| `live2-lifecycle/`, `live2-table/`, `live-life/`, `live-ui/`, `kit-fs/out-real/` | Small captured output (`*.txt`, `*.log`, each under 50 KB), the part that pages quote. |
| `tbl-drive/`, `hl/` | The tmux drivers, the screen analysers and the headless runner. |
| `README.md` | One row per spike: question, grade, key result. |

Absolute scratch paths in the files are replaced with `<SPIKES>` and `<SCRATCH>`, as the 2.1.295 snapshot did with `<SKILL_DIR>`. The folder holds 518 files and about 445 KB. Do not edit it. To add more evidence, make a new dated folder.

## `code-claude-com-2026-10-09/`

Raw Markdown of the public docs, fetched on 2026-10-09 from `https://code.claude.com/docs/en/<page>.md` (page list from `https://code.claude.com/docs/llms.txt`).

| Folder | Pages |
| --- | --- |
| `mods/` | All 10 mods pages: overview, create, events, api, interface, gallery, reference, test, troubleshoot, admin. The mods reference says it is "as of v2.1.290". |
| `plugins/` | The classic plugin pages (manifest, marketplace, loading, publish, CLI reference, security, and more). |
| `hooks/` | Classic settings hooks: `hooks.md`, `hooks-guide.md`. |
| `changelog-2.1.280-2.1.295.md` | Top of `anthropics/claude-code` `CHANGELOG.md`, versions 2.1.280 to 2.1.295. Mods were added in 2.1.287. |

Refresh: re-run the same `curl` loop into a new dated folder.

## `github-cache/` (not committed)

Public mod sources from GitHub, as a local cache. `.gitignore` excludes the folder: it is 6.6 MB, and the license for redistribution is not checked. Run `./fetch-github.sh` to fetch it at the pinned commits.

| Path | Repository | Commit |
| --- | --- | --- |
| `anthropics-claude-code/mods/` | [anthropics/claude-code](https://github.com/anthropics/claude-code/tree/e47cc82bdbd27b5f799acd5b05fd0c29d33bb48c/mods) | `e47cc82` |
| `anthropics-claude-code-playground/mods/` | [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/569c5283d9a0a7ee7938df85bb32e4f48cbb8c86/claude-code/mods) | `569c528` |

The first holds the built-in mods (`agents-md`, `diff`, `sec-default`, `telemetry`) and a `types/claude-code.d.ts`. That types file has 13,186 lines. The local 2.1.295 file has 21,451 lines. The local file wins.

## Precedence

types file (local build) > bundled `reference.md` / `SKILL.md` > public docs > GitHub samples > inference.

## Refresh procedure (bundled skill, new Claude Code version)

1. In a Claude Code session, load the `plugin-authoring` skill (`/plugin-authoring` or the Skill tool). This writes a fresh `<SKILL_DIR>`.
2. Create `claude-code-<version>/` beside the old folder. Copy `reference.md`, `examples/`, `types/`. Save the skill body as `SKILL.md`.
3. Re-run the CLI help commands into `cli-help.txt`.
4. `diff -r` against the old folder. Update topic pages and their citations. Write what matters to mod authors in `../reference/changes-<version>.md` (see `changes-2.1.302.md`), and move the pin in `../README.md` and `../AGENTS.md`.
