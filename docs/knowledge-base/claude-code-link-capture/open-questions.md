# Open questions

Unknowns, source conflicts and things not yet observed in a live session. Pinned to Claude Code 2.1.295. The page is [README.md](README.md).

"Observed" means a run of the 2.1.295 binary against a local fake API, kept in [`sources/live-observations-2026-10-10/`](sources/live-observations-2026-10-10/README.md). Every run used the REPL in a pseudo terminal or `-p`. None used a real model, a real account, a desktop surface or the fullscreen layout.

## Source conflicts

| # | Claim A | Claim B | State |
| --- | --- | --- | --- |
| 1 | Public docs say a user mod reloads its state in a `classic.SessionStart` hook after `/clear`, `/resume`, `/branch` ([docs: interface](../claude-code-mods/sources/code-claude-com-2026-10-09/mods/interface.md#L812), [docs: test](../claude-code-mods/sources/code-claude-com-2026-10-09/mods/test.md#L327)). | Observed: the debug log says `classic.SessionStart bypassed by cc-plugin-sec-default (tier user); beneath runs`. The mod's hook never ran, at startup or at `/clear` ([log](sources/live-observations-2026-10-10/logs/debug-classic-sessionstart.txt)). | Open. The mod does not depend on the hook. It compares `$.session.id()` instead. Related: [mods open-questions #19](../claude-code-mods/open-questions.md) (why `sec-default` loads here). |
| 2 | `reference.md:125` and [d.ts:5710](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L5710): a link outside `https:`, `http:`, `file:` "draws as text". | Observed: in a reply, `ftp:`, `ssh:`, `tel:`, `data:`, `javascript:`, `foo:bar` and relative destinations all draw as OSC 8 links ([c2](sources/live-observations-2026-10-10/ground-truth/c2.tsv), [c3](sources/live-observations-2026-10-10/ground-truth/c3.tsv)). | Settled for replies: the sentence is about the plugin `Markdown` element. The renderer's `linkSchemes` prop is set there and not in replies (*binary*). |
| 3 | The testing-kit page says the kit answers `$.state` ([testing-kit](../claude-code-mods/reference/testing-kit.md)). | In a test, `$.state` does not exist: `$.state.get(...)` throws `undefined is not an object`. Hooks under test read and write state fine. | Settled. A test reads state through the mod's own command, or through `read($, atom)` only inside a hook. The mods KB page may need a note. |
| 4 | The brief for this page says `claude` 2.1.295 is installed. | `claude` on PATH was 2.1.296 on 2026-10-10 (auto update). The 2.1.295 binary is at `~/.local/share/claude/versions/2.1.295`. | All checks here used the 2.1.295 binary. The three commands also pass on 2.1.296. |
| 5 | The brief for this page says to keep only http, https and file links. | The renderer makes a clickable span for any scheme. | The scanner keeps all of them and flags `web` (http, https, file). `/links` hides the rest. |

## Not yet observed

| # | Question | Why it matters | How to check |
| --- | --- | --- | --- |
| 1 | Does a reply over 1000 lines, or with a line over 100 000 characters, draw every link as plain text? *Inference from the binary:* the windowed path marks each link `defanged`. | The scanner would over-capture. | Reply with 1200 short lines and a link. Count spans with `osc8-spans.py`. |
| 2 | How do the desktop app, VS Code and mobile draw links in a reply? | The rules in section 2 are for the terminal. [d.ts:5635](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L5635) says the desktop uses an anchor. | Run the same corpora there. |
| 3 | Do the rules differ in the fullscreen layout (`CLAUDE_CODE_NO_FLICKER` unset)? Runs used the main-screen layout. | Click capture (`onLinkPress`) works only in fullscreen. | Repeat with the default layout. |
| 4 | What does a terminal without OSC 8 support draw for each case? *Binary:* `label (url)`. | A mod that reads the screen, not the row, would see different text. | Run without `FORCE_HYPERLINK`. The support table is owned by someone else. |
| 5 | Is the `owner/repo#12` host taken from the git remote, and which hosts get no link? Only the default (`github.com`) was observed. | Wrong host means a wrong captured URL. | Run in a repo with a GitLab, GHE and Bitbucket remote. The scanner has an `issueHost` option; the mod does not set it. |
| 6 | The text of a compaction summary row: its role, whether it holds links, whether it repeats earlier links. | The mod skips it. | Run `/compact` against the fake API with `row-logger`. |
| 7 | Does a foreground `Agent` call return the report in the `tool-result` row? Only the async launch notice was observed. | A second copy of the subagent text. Dedupe covers it. | Fake model: `Agent` with `run_in_background: false`. |
| 8 | What do `delivery`, `notice`, `tool-message` and `hook-context` rows hold when a link is shown? | Some links the person sees may not come from the model. | Trigger each and log the rows. |
| 9 | Does `--resume` or `--continue` keep the session id? | The restore finds `s:<id>` in `$.store` only if it does. Otherwise only the transcript is used. | Log `$.session.id()` in `session.start` across two runs. |
| 10 | Does the person see OSC 8 from Bash output as a clickable link? The row keeps the bytes. | The mod captures what the row holds, not what the screen shows. | Pty run with a Bash call that prints OSC 8. Changelog lines [343](../claude-code-mods/sources/code-claude-com-2026-10-09/changelog-2.1.280-2.1.295.md#L343) and [539](../claude-code-mods/sources/code-claude-com-2026-10-09/changelog-2.1.280-2.1.295.md#L539) show the engine cleans some control characters in other places. |
| 11 | Real tools that print OSC 8: `ls --hyperlink=always` (GNU), `rg --hyperlink-format`, `eza --hyperlink`, `gh`. | Not tried. BSD `ls` has no flag. | Run them under Bash and log the rows. |
| 12 | The order of "store the row" and "draw the block". | Only matters if a mod relied on the screen to be behind the transcript. | Not needed by the design. |
| 13 | Can a hook replace `AssistantMessage` with its own `Markdown` that has `onLinkPress`, and keep the reply's look? | It would give click capture on replies. | Prototype in the fullscreen layout. |
| 14 | Cost under load: many subagents write rows at once and `update` retries on a version miss. | A slow capture delays the next request. | Fake model with 20 parallel `Agent` calls. Read the `settled in` debug lines. |
| 15 | Two Claude Code sessions share one `$.store`. `get` then `set` of `index` is not atomic. | The 20-session index can lose an id. The data keys are not shared. | Run two sessions at once. |
| 16 | A link captured less than 1.5 s before `/clear` is not stored: the deferred copy runs after the reset, sees an empty list and writes nothing. | One recent link can be missing after `/clear`. | Capture, then `/clear` at once, then `/links`. A fix would flush when `ensure` sees a new id, which is too late: `$.state` is already empty. *Inference.* |
| 17 | `$.session.messages()` returns the newest 4096 entries ([d.ts:2740](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L2740)). | A resumed session with more loses the older links, unless `$.store` has them. | A long fake transcript. |

## Known scanner differences from the renderer

| # | Case | Renderer | Scanner |
| --- | --- | --- | --- |
| 1 | `[u](<https://e.com/<>)` (a second `<` inside angle brackets) | Link to `https://e.com/<` | Bare link to `https://e.com/` |
| 2 | HTML block type 7 (a lone `<a href=...>` line after a blank line) | *Inference:* an HTML block, no links | Scanned as text |
| 3 | A list inside a block quote, then an indented line | Not checked | Treated by the rules for a plain list |
| 4 | A tab inside the indentation | Not checked | Tab counts as 4 spaces |
| 5 | Markdown `marked` version drift | Unknown version and local patches | Pinned to what 2.1.295 drew |

## Process notes

- The `.claude-plugin/types/` folder is laid beside a mod when a real session loads it with `--plugin-dir`. `validate`, `test` and `tsc` do not lay it.
- A child Claude Code session inherits `CLAUDE_CODE_CHILD_SESSION` and then does not save its transcript. The live runs removed every `CLAUDE_CODE_*` variable from the child environment so `--continue` and `session.start` backfill could be seen.
- The bypass-permissions dialog blocks a pty run. Do not pass `--permission-mode bypassPermissions` there.
