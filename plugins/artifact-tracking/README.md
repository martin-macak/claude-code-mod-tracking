# artifact-tracking

A Claude Code mod. It tracks the GitHub issues and pull requests, the Jira work items, Claude artifacts and the web links that you or Claude mention in a session, and the Markdown files that Claude writes, edits, reads or names. It shows them in a `/track` pane and in a one-line band above the prompt.

`gh` and `acli` are optional. With them, the mod also shows live status: title, state, failing checks, Jira status and the Epic tree.

Design: [`docs/superpowers/specs/2026-10-10-artifact-tracking-design.md`](../../docs/superpowers/specs/2026-10-10-artifact-tracking-design.md). Evidence: [`docs/knowledge-base/claude-code-artifact-tracking/`](../../docs/knowledge-base/claude-code-artifact-tracking/README.md). Roadmap: the [GitHub Project](https://github.com/users/martin-macak/projects/3) shows the order of work and the status of each item.

## Load it

Mods are in early access. Tested with Claude Code 2.1.302.

Install it from the marketplace of this repo. In a Claude Code session (2.1.275 or later):

```text
/plugin install artifact-tracking --marketplace martin-macak/claude-code-mod-tracking
```

Answer `y` to add the marketplace `mod-tracking`, then pick a scope. From a shell (2.1.292 or later): `claude plugin install artifact-tracking --marketplace martin-macak/claude-code-mod-tracking`. Get a new release with `claude plugin update artifact-tracking@mod-tracking`.

Load a release zip for one session. Each [GitHub release](https://github.com/martin-macak/claude-code-mod-tracking/releases) attaches `artifact-tracking-<version>.zip`:

```bash
claude --plugin-url https://github.com/martin-macak/claude-code-mod-tracking/releases/download/artifact-tracking--v<version>/artifact-tracking-<version>.zip
```

Load the checkout for one session:

```bash
claude --plugin-dir plugins/artifact-tracking
```

## What it captures

| Row | Taken |
| --- | --- |
| Your prompt (typed, bridge, `-p`) | Every pattern below. |
| Your slash command | The text inside `<command-args>`. |
| Claude's reply, also from subagents | Every pattern below. |
| Tool output | Explicit GitHub issue and PR URLs and Jira URLs only. No bare `#N`, no web links. |
| Artifact tool call, also from subagents | A publish, a republish, an Artifact made from a type and an asset upload: the artifact, `published`. A delete marks its row `deleted`. An error, a refusal and the other actions add nothing. |
| `Write`, `Edit` and `Read` tool calls | A `.md` path: see [Markdown files](#markdown-files). |
| File tools, Bash and `agent.spawn` | Other git repos that the session or subagents touch (`Read`, `Edit`, `Write`, `NotebookEdit`, `Grep`, `Glob`, `cd`, `git -C`, `gh -R`, spawn `cwd`). |

Repo tracking runs in the background, after the tool has returned. One queue runs the git lookups one at a time and drops new ones when 32 wait. A file-tool call that failed or was denied adds nothing. A denied Bash command adds nothing. A Bash command that failed still counts: it touched the repo. A relative path in a Bash command or a file-tool call starts from the session cwd as it was before the call ran. In a subagent the cwd is unknown, so only absolute paths count. A `Glob` with no `path` and an absolute pattern counts for the part of the pattern before the first glob character. A nested subagent with no `cwd` counts with the `cwd` of its parent.

Each Repos row shows `read` or `edit`. `Edit`, `Write`, `NotebookEdit` and a git write subcommand (`commit`, `add`, `push`, `checkout`, `reset`, `rebase` and the like, after `git -C <dir>` or `cd <dir> &&`) mark the repo `edit`. Edit wins: a later read does not lower it. Everything else is `read`. The mark is a heuristic: a Bash write without git (`sed -i`, `npm install`, `tee`) counts as read. A failed or denied call adds nothing.

Repo tracking has two limits:

- Bash is read only for `cd`, `pushd`, `git -C` and `gh -R`. Other paths in a command are not tracked. A `cd` or `-C` target with `$`, a backtick, `*` or `?`, or with `-`, `~` or `~name`, is skipped.
- A relative path in a file-tool call of a subagent is ignored.

Select a Repos row and press `x`. It hides the repo for the rest of the run: a later visit, a restore and `/clear` do not bring it back. The dismiss list is not stored, so a new run shows the repo again. When the last repo is dismissed, the flush skips the empty list, so the stored copy may still hold it until the next write.

Not captured: notifications from background tasks, meta rows, prompts that a subagent or a coordinator wrote, and our own `/track` output.

The own repo never shows as a foreign repo. It is the toplevel of the session root, any worktree that shares its git common dir, and any clone with the same `origin`. A repo nested inside the root folder counts as own. A repo without a remote gets a `local:<git common dir>` key, so its worktrees share one row.

| Pattern | Item |
| --- | --- |
| `https://github.com/o/r/issues/N`, `/pull/N` | GitHub issue or PR |
| `o/r#N` | GitHub item, type found by `gh` |
| `#N` outside code and URLs | GitHub item of the session repo |
| `https://<site>.atlassian.net/browse/KEY-1`, `…?selectedIssue=KEY-1` | Jira work item |
| `/browse/KEY-1` on another host | Jira item, track-only |
| `https://claude.ai/artifact/<id>`, `https://claude.ai/code/artifact/<uuid>` | Claude artifact, `mentioned`. The two forms of one artifact are one item. Another path or a bad id is a web link. |
| Any other `http` or `https` URL | Web link. The name is the Markdown label, else host and path. |

An artifact row shows its name: the page title from the Artifact tool, else the Markdown label, else the file name or the id. A mention never changes a `published` row back. The same item written as a URL and as `#N` is one item. The session repo comes from the git `origin` remote. Without a remote, the mod asks `gh repo view` once.

## Commands

| Command | Action |
| --- | --- |
| `/track` | Opens the pane and starts a refresh of the due items. Prints a short list. |
| `/track refresh` | Forgets "not logged in" and "not found", closes open circuit breakers, refreshes every item, waits, and prints the list. Use it in `claude -p`. |
| `/track clear` | Removes all items of this session and its stored copy. The pane forgets its selected and open rows. |
| `/track help` | Prints the help view as text: every pane key, the config file path and the problems. Use it in `claude -p`. |
| `/track prio <ref> <level>` | Sets the priority of one item: `high`, `normal`, `low`, or `auto` to remove your mark. See [Priority](#priority). |

The pane has one section for each source: Worktrees, Agents, Pull requests, Jira, GitHub, Artifacts, Repos, Web links, Files and Processes. A section with nothing to show is left out. Each section starts with a title line and a bold header row of column names. A narrow terminal drops the less important columns first. The title, the key and the flexible column stay.

The pane keeps one selected row. A `>` in the first column and a highlight mark it. The selection follows the row, not its place: a re-sort, a refresh or a new row above it does not move it. A footer lists the keys. A key that does not fit the selected row draws dim and does nothing.

| Key | Action |
| --- | --- |
| Tab, Shift+Tab | Select the next or the previous row. |
| Enter | Opens or closes the selected row. Every row opens. A Jira row shows its children. A leaf shows its full cells and its link. On an `N more` row, Enter shows the next rows of that section. |
| `r` | Refreshes. Does what `/track refresh` does. |
| `h` | Swaps the pane to the help view: every key, the config file path and the problems. `h` again goes back. |
| `x` | Dismisses the selected row. It stays out for the run, also after `/clear`. |
| `1` `2` `3` `0` | Set the priority of the selected row. See [Priority](#priority). |
| Esc | Closes the pane. |

A section shows at most `global.ui.sectionRows` rows (50). When rows are left, the section ends in an `N more` row. The whole pane shows at most `global.ui.maxRows` rows (300), plus the chunks you opened. Open children do not count against these caps. If the pane is still too large to draw, it drops the detail lines first, then shows fewer rows, and last shows one line: `The pane is too large to draw. /track prints the list.`

A 30 s tick runs from the start of the session, with the pane open or closed. An item is stale after 5 minutes, or after 60 s for a PR with pending checks.

A deleted artifact stays in its section, dim and without a link.

The band shows `tracking  Jira 6 · GitHub 4 (1 ✗) · Artifacts 3 · Links 2 · Files 3 · Repos 2  /track`. `(n ✗)` counts PRs with failing checks. `Artifacts n` counts the artifacts that are not deleted. `Repos` and the auto parts (Worktrees, Agents, PRs) come after `Files`. The band is empty when nothing is tracked.

### Markdown files

The Files section has one row per Markdown file (issue #28):

```text
Files  3 files
  docs/plan.md      created  edited 3  viewed 2
  README.md                  edited 1  viewed 5
  docs/notes.md     mentioned          viewed 1  subagent
```

| Cell | Counts |
| --- | --- |
| path | Relative to the session root when the file is below it, else absolute. |
| `created` | A successful `Write` of type `create` made the file. It stays set. |
| `mentioned` | Your prompt, your command arguments or Claude's reply named the path, and the file exists. Shown when the file was not created. |
| `edited N` | Successful `Edit` calls and `Write` calls of type `update`. |
| `viewed N` | Successful `Read` calls. A `Read` alone never adds a row: it counts only on a row that a write, an edit or a mention made. |
| `subagent` | A subagent wrote, edited or read the file. |

An empty cell means that activity did not happen. The `/track` text leaves empty cells out.

Rules:

- Only `.md` paths count, in any case. A failed, denied or staged call adds nothing.
- A relative path joins the cwd: the spawn cwd of a subagent, else the session cwd. `~/` in a mention joins `HOME`.
- A row is keyed by where the file lands (`file:<real path>`): two spellings of one file, such as `/tmp/a.md` and `/private/tmp/a.md`, are one row. A case alias or a hard link stays a second row. The row keeps the path as first spelled.
- Mentions: by default at most 20 paths per prompt or reply (`trackers.file.maxMentionsPerRow`), each checked with one stat. A URL, a missing file and tool output are not mentions. A trailing line number (`a.md:42`) or anchor (`a.md#L7`) is cut.
- Ignored paths, fixed: a `.git` or `node_modules` folder, auto-memory under `<config dir>/projects/<project>/memory/` or under the `autoMemoryDirectory` setting, and the Claude scratchpad (`claude-<uid>/<project>/<session>/scratchpad/` under any temp folder). The config dir is `CLAUDE_CONFIG_DIR`, else `~/.claude`. Below the session root, only a `.git` or `node_modules` folder below the root counts, so a project inside such a folder keeps its files. `CLAUDE.md`, `AGENTS.md` and plans stay tracked.
- File rows count against the session item cap (500 by default) like other items. The oldest row goes first.
- Select a file row and press `x` to hide it for the run. A later write, edit, read or mention of the same file does not bring it back.
- A resume restores file rows from the stored copy, then from the `Write`, `Edit` and `Read` results and the mentions in the transcript. A subagent's writes come back from the stored copy only: its transcript holds no results.
- Paths only. The mod never reads or stores file contents.

## Priority

Each row in the Jira, GitHub, Artifacts, Web links, Files and Pull requests sections starts with a mark. Worktrees, Agents, Repos and Processes rows have none.

| Key | Action on the selected row |
| --- | --- |
| `1` | Sets `high`. The row shows `▲`. |
| `2` | Sets `normal`. No marker. It overrides an auto level. |
| `3` | Sets `low`. The row shows `▽`. |
| `0` | Removes your mark. The auto level shows again, if a rule gives one. |

Select a row first: Tab and Shift+Tab move the selection, and a `>` and a highlight mark it. Then press the digit. The keys work while the pane has the keyboard, and the footer lists them: `1 high  2 normal  3 low  0 auto`. On a row that cannot take a mark (Worktrees, Agents, Repos, Processes), the digits draw dim and do nothing. After a key, the selection stays on the row and the row moves to its new place.

Sections sort by level first, then by their usual order. A Jira child row sorts inside its parent. The `/track` text shows the same marker before the key.

A rule can also give a level. It draws dim. Your own mark always wins.

| Rule | Level |
| --- | --- |
| An open PR of the session repo whose head is the current branch: the branch of the session's cwd, also after `EnterWorktree`. | `top`, shown `★` |
| An issue that a tracked PR closes, by GitHub's closing references. | The highest level of those PRs, `low` included. |

`/track prio <ref> <level>` does the same from the prompt, also in `claude -p`. `<ref>` is a Jira key (a child key too), a URL, `o/r#N` or `#N`. `<level>` is `high`, `normal`, `low` or `auto`. The command saves the list before it replies.

The item cap never drops the newest 100 `high` items.

## Auto tracking

The mod also tracks the work around the session, with no mention:

| Section | Content |
| --- | --- |
| Worktrees | The root (the cwd at session start, pinned) and the worktrees that this session or its agents made. Only proven children show. A removed one stays, dimmed. |
| Agents | The main loop, its subagents and its workflow agents, each with branch and worktree. An ended agent stays, dimmed. |
| Pull requests | PRs whose head is a tracked branch, or whose base is a tracked branch (stacked PRs). One GraphQL query for each 30 s tick. |

The refs in a PR body become items with a `↳#N` prefix. HTML comments are skipped. The items go when the PR leaves the tracked set. The band adds `Worktrees n · Agents n · PRs n`.

```mermaid
flowchart LR
  E[tool.call and agent.spawn events] --> S[AutoScheduler 750 ms window]
  T[30 s tick] --> S
  S --> R[AutoRound]
  R --> G[git worktree list]
  R --> A[agent.list]
  R --> Q[one GraphQL query]
  R --> U[pane and band]
```

Select an auto row and press `x` to hide it for the run. `/track clear` hides every auto row that is on screen. A gh failure trips the same circuit breaker as item refresh. It never stops worktree or agent tracking.

Limits: peer sessions in other processes are not tracked. A worktree that git created without this session is not shown. Design: [`docs/superpowers/specs/2026-10-10-auto-tracking-design.md`](../../docs/superpowers/specs/2026-10-10-auto-tracking-design.md).

## Requirements

- Claude Code with mods (2.1.295 or newer).
- Optional: `gh` 2.102 or newer, logged in. It refreshes GitHub items with one GraphQL call for each host. A GitHub Enterprise host works when `gh auth status --hostname <host>` succeeds.
- Optional: `acli` 1.3.19 or newer, logged in. It refreshes Jira items on its active site.
- Without a tool, its section says `not installed` or `not logged in`. The items stay in the list.

By default, a tool that fails three times in a row is paused for 5 minutes (circuit breaker, see [Configuration](#configuration)). The section says `paused 4m`. `/track refresh` lifts the pause.

## Persistence

- By default, items live in `$.state` and are copied to `$.store` 1.5 s after a change. The store keeps the newest 20 sessions, and each session keeps up to 500 items (see [Configuration](#configuration)). Only the extracted fields are stored, never raw CLI output.
- `/clear` gives a new session. The items of the old session carry over, with their priority marks. The live list wins over an older stored copy.
- `x` and `/track clear` remove an item with its mark. An item tracked again starts with no mark. A new session starts with no marks.
- `--resume` and `--continue` restore the stored copy, then add what the transcript holds. Restored items are due for a refresh.

## Configuration

One JSON file holds the settings of the mod: the global limits, and for each tracker an on/off switch and its limits. With no file, the mod uses the defaults in the tables below.

Where the file is, in this order:

1. `CLAUDE_TRACKER_CONFIG_DIR`, when it is an absolute path: `<dir>/config.json`. The tests use it. A relative value is ignored, with one problem.
2. `$XDG_CONFIG_HOME/claude-code/mods/tracker/config.json`, when `XDG_CONFIG_HOME` is an absolute path.
3. `~/.config/claude-code/mods/tracker/config.json`.

One file serves every Claude Code profile. With no absolute `HOME` and no override, the mod uses the defaults and never reads or writes a file.

The file is strict JSON: no comments, no trailing commas. The first start writes the defaults once. Later starts add only the keys that are missing, once, and never change a value. A file with no key missing is never rewritten, whatever its indent, its final newline or its key order. When the mod adds a key, it writes the whole file with a two-space indent. It puts `version`, `global` and `trackers` first and keeps the order of your other top-level keys. Inside an object, your keys keep their order and the added keys come last. It never writes the file in `session.end`. It never rewrites a file that it cannot parse. If a write is refused, the defaults work, `/track` shows one problem, and the mod tries again at the next start.

An excerpt of the default file. The real file also holds `store`, `ui` and the `trackers` block:

```json
{
  "version": 1,
  "global": {
    "refresh": {
      "tickMs": 30000,
      "staleMs": 300000,
      "captureDebounceMs": 1000,
      "flushMs": 1500
    },
    "tools": {
      "timeoutMs": 30000,
      "probeTimeoutMs": 10000,
      "breaker": {
        "threshold": 3,
        "openMs": 300000
      }
    }
  }
}
```

To turn a tracker off, write `enabled: false` in its slice. Write the whole slice. `"web": false` does not turn web off:

```json
{ "version": 1, "trackers": { "web": { "enabled": false } } }
```

A tracker that is off captures nothing, runs no tool and shows no section. A URL that an off tracker owns is not tracked as a web link either. At the start, the mod drops the items of an off item tracker (`github`, `jira`, `web`, `artifact` and `file`) from the session. The data of `repos`, `processes` and `auto` stays, frozen and hidden.

When a value applies:

- A tracker switch: at the next start of Claude Code, also after `--resume` or a reload.
- `global.tools.breaker.*`, `trackers.jira.concurrency` and `trackers.repos.maxRepoQueue`: at the next start. They size an object at its construction.
- Every other value: within one tick (30 s by default). `/track` and `/track refresh` check the file first, so they show an edit at once.

Problems: `/track` lists them under the path of the file, after the list.

- A value of the wrong type, or a decimal, uses its default. A number below the min or above the max uses the bound.
- A key or a tracker id that the mod does not know is kept in the file and ignored. The problem names it.
- A file that is not valid JSON, or not one object, keeps the last good values and is never changed. Fix the file. The mod reads it at the next check, with no restart.
- A file with a `version` above 1 is read and never changed.

Every key. Time values are in milliseconds.

| Key | Default | Min | Max | Meaning |
| --- | --- | --- | --- | --- |
| `global.refresh.tickMs` | 30000 | 5000 | 600000 | Time between ticks. |
| `global.refresh.staleMs` | 300000 | 30000 | 86400000 | Age at which a refreshed item is due again. |
| `global.refresh.captureDebounceMs` | 1000 | 100 | 60000 | Wait after a new item, then refresh. |
| `global.refresh.flushMs` | 1500 | 100 | 60000 | Wait after a change, then copy to the store. |
| `global.tools.timeoutMs` | 30000 | 1000 | 300000 | Timeout of one `gh` or `acli` call. |
| `global.tools.probeTimeoutMs` | 10000 | 1000 | 120000 | Timeout of the `--version` probe of a tool. |
| `global.tools.breaker.threshold` | 3 | 1 | 100 | Failures in a row that pause a tool. |
| `global.tools.breaker.openMs` | 300000 | 1000 | 86400000 | Length of the pause. |
| `global.store.keepSessions` | 20 | 1 | 200 | Sessions kept in the store. |
| `global.store.maxItems` | 500 | 200 | 5000 | Items kept for one session. |
| `global.store.maxDismissed` | 500 | 50 | 5000 | Hidden auto rows remembered. |
| `global.store.maxBytes` | 3000000 | 100000 | 4000000 | Size cap of the stored copies. The oldest sessions go first. |
| `global.ui.maxRows` | 300 | 50 | 1000 | Rows the whole pane shows at most, plus the chunks you opened with `N more`. Open children do not count. |
| `global.ui.sectionRows` | 50 | 5 | 300 | Rows one section shows at most. Each Enter on its `N more` row adds this many. |
| `trackers.<id>.enabled` | true | | | Switch of each of `github`, `jira`, `web`, `artifact`, `file`, `repos`, `processes` and `auto`. |
| `trackers.github.chunkSize` | 50 | 1 | 100 | Items in one GraphQL call. |
| `trackers.github.pendingStaleMs` | 60000 | 10000 | 3600000 | Age at which a PR with pending checks is due again. |
| `trackers.github.discoveryTimeoutMs` | 10000 | 1000 | 120000 | Timeout of the PR discovery call. |
| `trackers.github.closingRefsPerPr` | 10 | 1 | 50 | Closing references read for one PR. |
| `trackers.github.headPrsPerBranch` | 5 | 1 | 50 | PRs read for one branch as head. |
| `trackers.github.basePrsPerBranch` | 10 | 1 | 50 | PRs read for one branch as base. |
| `trackers.github.maxBodyRefs` | 50 | 1 | 200 | References read from one PR body. |
| `trackers.github.maxAutoItems` | 100 | 1 | 200 | Items that only the PR lane added. It was `trackers.auto.maxAutoItems`. |
| `trackers.github.shortRefKeywords` | `["github", "bug", "issue", "issues", "enhancement", "chore"]` | | 32 words | Lead words that make a bare `#N` in the conversation an issue. A word has 1 to 32 characters: a letter, then letters, digits or `-`. The mod lowercases it. |
| `trackers.jira.concurrency` | 3 | 1 | 10 | Parallel `acli` calls. |
| `trackers.jira.epicChildLimit` | 50 | 1 | 500 | Children read for one Epic. |
| `trackers.file.maxMentionsPerRow` | 20 | 0 | 200 | `.md` paths read from one prompt or reply. 0 reads none. |
| `trackers.repos.maxRepos` | 50 | 1 | 500 | Repositories listed. |
| `trackers.repos.maxRepoAgents` | 8 | 1 | 50 | Agents named on one repository. |
| `trackers.repos.maxRepoQueue` | 32 | 1 | 256 | Repository lookups that wait in the queue. |
| `trackers.repos.gitTimeoutMs` | 5000 | 500 | 60000 | Timeout of one `git` call for a repository. |
| `trackers.processes.probeTimeoutMs` | 10000 | 1000 | 120000 | Timeout of a process probe. |
| `trackers.auto.debounceMs` | 750 | 50 | 60000 | Window that groups the events of auto tracking. |
| `trackers.auto.gitTimeoutMs` | 5000 | 500 | 60000 | Timeout of one `git` call of auto tracking. |
| `trackers.auto.workflowIdleMs` | 3600000 | 60000 | 86400000 | Time with no sign of life after which a workflow agent ends as stale. |
| `trackers.auto.maxBranches` | 12 | 1 | 50 | Branches that the PR lane polls. |
| `trackers.auto.maxProofs` | 100 | 10 | 1000 | Worktree proofs kept. |
| `trackers.auto.maxAgents` | 200 | 10 | 2000 | Agents kept. |

## Known limits

- **False positives.** `rank #1` counts as issue 1 of the session repo. The scanner cannot tell it from `fixed in #1`.
- **Focus after a background change.** A row that appears above the focus ring moves the ring onto another row: the ring sits on a position, not on a row. The `>` and the highlight stay on your row, and `x` and the digits act on it, not on the ring. Tab moves the ring again. After `x` or a digit, the ring goes back to the selected row. After a `ctrl+x Tab` chord that gives the keys back to the pane, no row has the ring until the first Tab. `r` leaves the ring where it was.
- **Closing references.** An issue takes a PR's level only from the first closing references that GitHub lists for the PR (10 by default).
- **Jira sites.** `acli` works on one site at a time. A work item on any other site is `track-only`. The mod never runs `acli jira auth switch`. A host that is not `*.atlassian.net` is also `track-only`.
- **GitHub Enterprise.** A GHE issue URL is a web link, unless the host is the host of the session repo and `gh` is logged in to it.
- **Other github.com URLs** (repo pages, commits, files) are web links.
- **Bare `#N` without a repo** stays unresolved. It has no link and no status.
- **`/clear`.** The items come back at the next hook, command or 30 s tick, not at the `/clear` itself. The tick runs from session.start. A `/resume` of a session that the store knows restores that session only, not the one you left.
- **`--resume` backfill.** The transcript has no `isMeta` or origin flags. The backfill skips the wrappers it knows (`<system-reminder>`, `<teammate-message>`, command output, task notifications). Other meta rows, for example a skill body or a coordinator message, may add items that the live session did not track.
- **`claude -p "/track"`** ends before its background refresh finishes. Use `/track refresh`.
- **Artifact tool.** `claude -p` does not offer it, so nothing is published there. A mentioned artifact URL is still tracked.
- **Artifacts after `--resume`.** The stored copy keeps the origin, the title and the delete mark. Without a stored copy, the transcript gives them back, except for a subagent's publish: the main transcript does not hold it, so its URL comes back `mentioned` at most. Only deletes in this session mark a row.
- **Older versions** stored artifact URLs as web links. A session moves them to Artifacts when it loads its list.
- **Help view in a short inline pane.** When the pane sits inline under the transcript and has few lines, the help view opens scrolled to its footer, so its first keys are above the view. Scroll up to see them, or make the terminal taller.
- **Upgrade in a running session.** An upgrade inside a running session keeps the tracked items. It drops the Repos and Processes rows until the mod sees them again, and it forgets the dismiss list, so a dismissed row can come back.
- **A narrow terminal.** The pane may wait until you widen the terminal. The mod shows a toast.
- **Out of scope:** page titles of web links, switching Jira sites, Jira levels above Epic, click capture, write actions on GitHub or Jira, and surfaces other than the terminal.

## Develop

Only `hooks/register.tsx` uses `$`. Every other module gets plain functions, so the unit tests need no engine.

```bash
cd plugins/artifact-tracking
claude plugin validate .
mise exec node@24 -- npx -y -p typescript tsc -p .
claude plugin test .
```

| Folder | Content |
| --- | --- |
| `hooks/register.tsx` | Hooks, command, timers, state, store, render. |
| `hooks/` (rest) | The hook events (`events.ts`) and the pane state: `pane-session.ts` (selection, help, `N more`, key presses), `pane-queue.ts` and `pane-text.ts` (the `/track` text and the help text). |
| `core/lib/` | Pure helpers: JSON parsing, `git status` porcelain, shell splitting, the link scanner, the config schema rules (`normalise.ts`) and the global config (`global-config.ts`). |
| `core/infra/` | The base `Tool` and the circuit breaker, the refresh coordinator, the scheduler, the dismiss store, the pane key registry and key routing (`keys.ts`, `pane-keys.ts`), and the config path rule, file format and `ConfigManager` (`config-path.ts`, `config-file.ts`, `config-manager.ts`). |
| `ux/` | Pure drawing code, one component for every section: `tree-data-table/` (the table, the column solver, the budget guard, the help view and the `/track` text), `band.ts`, `theme.ts` and `text/cell-width.ts`. It imports only `core/interfaces/`. |
| `trackers/github/` | GitHub items, `GhTool`, PR discovery and the PR body scanner. |
| `trackers/jira/` | Jira items and `AcliTool`. |
| `trackers/web/` | Web links. |
| `trackers/artifact/` | Artifact items, the Artifact tool call as an event (for the hook and the resume backfill) and artifact URLs and ids. |
| `trackers/file/` | File items and the Markdown path scanner. |
| `trackers/repos/` | Repository hints, identity, paths, queue, rows, tracker and view. |
| `trackers/processes/` | Process parsing, probing and view. |
| `trackers/auto/` | Ledger, worktrees, agents, events and round of auto tracking. |
| `trackers/*/config.ts` | One config spec for each tracker: its schema, defaults and `ConfigSpec`. |
| `tests/` | Unit tests, fixtures, and the kit tests of the wiring (`register.test.tsx`, `artifact-wiring.test.tsx`, `config-wiring.test.tsx`). |

## CI

`.github/workflows/test.yml` runs on every pull request, on each push to `main`, and by hand. It installs Claude Code 2.1.302 and TypeScript 7.0.2 at fixed versions. Then it runs `make test`: `claude plugin validate`, `tsc -p .`, `claude plugin test`, then `make coverage` (`node --test` over the pure tests, with a 90% gate on lines, branches and functions, and `scripts/coverage/check.mjs`). A drop below 90% fails CI and the pre-push hook. No login or secret is needed.

## Release

A release is a git tag `artifact-tracking--v<version>`. The tag sets the version. Do not edit `plugin.json` to make a release. Its value on `main` does not control the stamped zip.

1. Merge the release changes. Use a clean `main` equal to `origin/main`.
2. Run `make release-dry VERSION=0.2.0-rc.1`. It checks the branch, tree, remote and SemVer order without tagging or pushing.
3. Run `make release VERSION=0.2.0-rc.1`. It runs `make test`, creates an annotated tag and pushes it.
4. For a stable release, use `VERSION=0.2.0`. If `gh` is present, milestone `artifact-tracking 0.2.0` must have no open issues. A missing `gh` skips this guard with a message. API errors stop the release. Pre-releases skip the milestone check.

The tag push runs `.github/workflows/release.yml`. The workflow:

- rejects a bad tag or a tagged commit outside `main` before the build,
- stamps the tag version with `jq`, then validates the plugin and marketplace and runs `make test`,
- runs `make dist VERSION=<version>`: tracked plugin files at `HEAD`, with only the manifest version stamped in staging,
- publishes identical `artifact-tracking-<version>.zip` and `artifact-tracking.zip`, their `SHA256SUMS`, and build provenance,
- marks `x.y.z-*` as a pre-release with `--latest=false`; stable releases use `--latest` and close their milestone,
- installs the published archive in a temporary `CLAUDE_CONFIG_DIR`, compares the installed version and all files, and tests an update from the old 0.1.0 path entry. An RC also checks that `latest` did not change.

The marketplace cutover is a second PR. After the first stable release carries `artifact-tracking.zip`, run `make marketplace-release`. It checks the latest release asset before changing `.claude-plugin/marketplace.json` to `https://github.com/martin-macak/claude-code-mod-tracking/releases/latest/download/artifact-tracking.zip`. Run `make verify` and merge that diff. Until then, the path entry still installs `main`; bootstrap smoke uses a temporary archive catalog. An RC before the first stable alias checks its own archive and leaves the stable install/update checks pending.

After cutover, fresh installs and `claude plugin update artifact-tracking@mod-tracking` fetch the latest stable archive. Pre-releases remain available by their versioned URL. Tag-based dependency resolution against the source tree is no longer supported: the tagged manifest keeps its development value. See [the release workflow](../../docs/knowledge-base/claude-code-mods/workflow/release.md).

Verify a downloaded zip:

```bash
sha256sum -c SHA256SUMS
gh attestation verify artifact-tracking-<version>.zip --repo martin-macak/claude-code-mod-tracking
```

## Make targets

Run `make` from the repo root. `make help` lists the targets. Set `PLUGIN=<dir>` to use another plugin folder.

| Target | Action |
| --- | --- |
| `init` | Checks `claude`, `mise` and node. Reports `gh`, `acli` and `pre-commit` as present or missing. A missing optional tool does not fail. Warns when the `gh` token lacks the `project` scope, or when `gh` is older than 2.94 (`scripts/dev/gh-check.sh`). Warms the TypeScript cache for offline runs. |
| `build` | Runs `claude plugin validate` on the plugin, and `--strict` on the repo root (the marketplace), then `typecheck`. Nothing is emitted. Claude Code loads the `.ts` and `.tsx` files as they are. |
| `typecheck` | Runs `tsc` on the plugin, on `e2e/` and on `scripts/coverage/`. The `typecheck` pre-commit hook calls it. |
| `lint` | Runs every pre-commit hook on all files. |
| `hooks` | Installs the `pre-commit`, `commit-msg` and `pre-push` git hooks. |
| `verify` | The gate before every push: `lint` with auto-fix, then `test`, `e2e-unit` and `test-scripts`. Fails on untracked files, because the hooks skip them. |
| `test` | Runs `build`, then `claude plugin test`, then `coverage`. `check` is an alias. |
| `coverage` | Runs every `tests/**/*.test.ts` except `*.kit.test.ts` under `node --test` and fails below 90% lines, branches or functions over `core/`, `ux/`, `trackers/` and `hooks/`. `scripts/coverage/check.mjs` then fails when a source file is missing from the report. |
| `test-scripts` | Tests the verify gate (`scripts/hooks/verify-gate.sh`), the coverage shim and `check.mjs`, the GitHub scope check, release guards, packaging, smoke comparisons, and the `pr-review` and `project-sync` skills. It also checks the planning docs. Needs no `claude`. |
| `project-sync` | Runs the `project-sync` skill: `ARGS='sync'` (default), `next`, `add`, `status`. `sync`, `next` and `add` are dry runs unless `ARGS` has `--apply`. `status` writes at once. See `AGENTS.md`, "Planning and delivery". |
| `dist VERSION=x.y.z` | Builds both plugin zips from tracked `HEAD` files, stamps the supplied version in staging, and writes `dist/SHA256SUMS`. |
| `release VERSION=x.y.z` | Checks clean, current `main`, SemVer order and milestone, runs `test`, then creates and pushes the tag. |
| `release-dry VERSION=x.y.z` | Runs the release guards and prints the tag without testing or pushing. |
| `marketplace-release` | Checks the latest archive asset, then edits the marketplace for a cutover PR. |
| `install` | Links the mod into `$CLAUDE_CONFIG_DIR/skills/`. Without that variable, it uses `~/.claude/skills/`. For another profile, run `CLAUDE_CONFIG_DIR=<dir> make install`. |
| `uninstall` | Removes that link. It removes only a link that points at this plugin. |
| `clean` | Deletes `.claude-plugin/types/` and `dist/`. The engine writes that folder on a real load. |

`install` makes a symlink, so Claude Code loads the mod in place as `artifact-tracking@skills-dir`. Edits reload by themselves. Run `make install` from the checkout that you keep, not from a temporary worktree. Start a new session or run `/reload-plugins` after `make install`. Running it twice is safe.

`make install` loads your local branch in place of the released channel. The released `artifact-tracking` uses the same name, so disable it while you test: `claude plugin disable artifact-tracking@mod-tracking`, and later `claude plugin enable artifact-tracking@mod-tracking`. If `/reload-plugins` leaves `/track` unknown, restart with `claude --continue`.
