# Open questions

Unknowns and source conflicts found while building this KB (2026-10-09, Claude Code 2.1.295). Resolve an item by experiment or a newer source. Then move the answer into the right page and delete the item here.

Precedence when sources conflict: types file > bundled `reference.md` / `SKILL.md` > public docs > GitHub samples > inference.

## Source conflicts

| # | Question | Sources in conflict | KB currently follows |
| --- | --- | --- | --- |
| 1 | Do `vscode` and `mobile` draw mod trees? | The types list 4 surfaces, with element tables for each ([d.ts:10380](sources/claude-code-2.1.295/types/claude-code.d.ts#L10380)). Public docs say the VS Code panel and Remote Control draw nothing, and list only terminal and desktop ([docs: overview](sources/code-claude-com-2026-10-09/mods/overview.md#L189)). | Types for element tables. Public docs for where drawing happens. |
| 2 | Does an element that the surface lacks refuse the tree, or draw nothing? | [reference.md:127](sources/claude-code-2.1.295/reference.md#L127) and docs say the tree is refused. The types and a test run show the table constructor yields an empty fragment ([d.ts:3788](sources/claude-code-2.1.295/types/claude-code.d.ts#L3788)). A hand-written node is refused. | Both, as stated. |
| 3 | Is `Svg` desktop-only? | Public reference says so ("as of v2.1.290"). Types give `Svg` to desktop, vscode and mobile. | Types. |
| 4 | Is `$.store` shared by every session on the machine? | Public docs say yes. Types say "kept between sessions and hot reloads", nothing on sharing. | Docs, marked. |
| 5 | Which `/resume` and `/branch` cases fire `session.start`? | Docs say it does not fire after `/clear`, `/resume`, `/branch`. Types say "never `/clear`" and describe re-fires on reload, enable, worker respawn. | Docs, marked. |
| 6 | Does `telemetry.mark` take a `to` matcher? | Public docs require `{ to: 'collector' }` for third-party telemetry hooks, `mark` included. The types give `mark` no `to`. The `validate` rule is not in the types. | Types. |
| 7 | Which version turned mods on by default? | Overview: terminal 2.1.287, desktop 2.1.286. `admin.md:11`: 2.1.286. Changelog: 2.1.287. | Overview. |
| 8 | The `SKILL.md` text says the API file has "about 14,000 lines". | The local file has 21,451 lines. The GitHub `mods/types` file has 13,186. | The local file. |

## Only in public docs (not in the types)

- The 50 ms budget for `prompt.edit` hooks ([docs: reference](sources/code-claude-com-2026-10-09/mods/reference.md#L278)).
- The toast `timeoutMs` range 1 to 60000.
- `prompt.autocomplete` is the reverse case. It is in `EngineEventOf` but in neither public event table.

## Not yet observed

| # | Question | How to settle it |
| --- | --- | --- |
| 9 | Does the engine lay `.claude-plugin/types/` for a `--plugin-dir` folder under `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`? `validate`, `test` and `-p` do not lay it (observed). | Load a mod with hot reload enabled. Check the folder. Snapshot `claude-code-tools` and `claude-code-mcp` into `sources/` then. |
| 10 | With a custom config dir, does `CLAUDE_CODE_PLUGIN_DIRS` read `$CLAUDE_CONFIG_DIR/settings.json`? Does the skills-folder auto-load use `$CLAUDE_CONFIG_DIR/skills/`? The dev-mods folder does follow the config dir (observed: `~/.claude-personal/dev-mods/<id>`). | Set the env var in `~/.claude-personal/settings.json` and start a session. |
| 11 | Does `claude -p` print `ui.render ... refused` on stderr? Only module-load lines are documented there ([reference.md:80](sources/claude-code-2.1.295/reference.md#L80)). | Run a mod with a bad tree under `-p`. |
| 12 | A plugin `{ deny }` on `tool.call` resolves as `{ deny }` under `claude plugin test` (observed). `reference.md:81` describes only the classic `PreToolUse` deny path. | Confirm in a live session. |
| 13 | What does "ten seconds after the noun was called the hook itself is asked again, unless its own dispatch is still above" mean ([reference.md:79](sources/claude-code-2.1.295/reference.md#L79))? | Build a re-entry test with a slow noun call. |
| 14 | Does `StateSetEvent` carry `previous`, or only the untyped `StateWrite` ([d.ts:12104](sources/claude-code-2.1.295/types/claude-code.d.ts#L12104))? | Hook `state.set` in a test and log `e`. |
| 15 | What exactly resets on `/clear`: module variables, timers, open panes? The KB infers it. | Test in a live session. |
| 16 | `console.log` in a hooks module printed nothing under `claude plugin test` (one observation). Where does it go in a live session? | Check `claude --debug` output. |
| 17 | The value exports of `'claude-code'` (`atom`, `read`, `update`, ...) work at run time. The types header says "at run time the import is empty". | Settled in practice: the bundled examples import them and pass `claude plugin test`. Clarify the header's meaning. |
| 18 | The built-in `telemetry` mod at `e47cc82` fails `validate` as a user plugin (observed). The CLI gives no hint about tiers. | Note only. It matters if we copy patterns from it. |
| 19 | Why does the built-in `sec-default` guard load on this machine: managed settings, or a Team/Enterprise sign-in? | Check `/plugin` and the managed settings. |
| 20 | **Resolved, 2026-10-18:** `--plugin-url` loads the GitHub 0.1.0 release asset through its redirect on Claude Code 2.1.302. | Isolated CLI probe loaded `artifact-tracking@inline`, version 0.1.0. See [recorded checks](workflow/release.md#recorded-checks-and-rollout-status). |
| 21 | **Closed as obsolete:** the tag-first pipeline uses `git tag -a` and `git push`, not `claude plugin tag --push`. | The old 0.1.0 tag has a published release. A push from the new pipeline remains a rollout check. See [release flow](workflow/release.md#the-pipeline-in-this-repo). |

## See also

- [gotchas](gotchas.md)
- [sources/README](sources/README.md): provenance and refresh.
