# Open questions

Unknowns, source conflicts, review corrections and the decisions only the user can make. The index is [README.md](README.md).

Pins: Claude Code 2.1.295 (cross-checked on 2.1.296), `gh` 2.102.0, `acli` 1.3.19-stable.

## 1. Source conflicts

| # | Claim A | Claim B | State |
| --- | --- | --- | --- |
| C1 | d.ts says origin `sdk` is "the SDK host's own turn (`claude -p`, the Agent SDK)" ([d.ts:8880](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L8880)). | The typed prompt of a `claude -p` run had `origin.kind: 'unclassified'` ([row](../claude-code-link-capture/sources/live-observations-2026-10-10/rows/subagent-background.json)). `sdk` was never seen. | Open. An allow-list of `composer` and `bridge` misses `-p` prompts. See decision D3. |
| C2 | Researcher: a network failure on `search` and bad JQL share one message. | The texts differ. Network: `failed to parse JQL` ([07](sources/acli-1.3.19/07-search-network-failure.txt)). Bad JQL: `failed to parse JQL query: <detail>` ([13](sources/acli-1.3.19/13-search-bad-jql.txt)). | Settled by review. An exact match tells them apart. `view` still has a real collision (see [jira.md §5](jira.md#5-errors-and-exit-codes)). |
| C3 | Researcher: `parent in (A,B,C)` fetches "a whole level in one call". | `search` cannot return `parent` ([15](sources/acli-1.3.19/15-search-field-not-allowed.txt)). The sample [33](sources/acli-1.3.19/33-search-children-batch--parent-in.json) holds children of one parent only. | Settled by review. The call works, but the result cannot say which child belongs to which parent. Use it only for one parent, or for a flat count. See [jira.md §4](jira.md#4-subtasks-and-the-tree). |

## 2. Review log (synthesis stage, 2026-10-10)

Each row is a researcher claim that the review checked against a saved file.

| # | Claim | File checked | Verdict |
| --- | --- | --- | --- |
| R1 | `gh pr checks --json` exits 0 when a check failed. | [pr-checks-14640-json-jq-fail-count.txt](sources/gh-2.102.0/pr-checks-14640-json-jq-fail-count.txt) (`1`, `exit=0`); [plain](sources/gh-2.102.0/pr-checks-14640-plain.txt) (`exit=1`) | Confirmed. |
| R2 | A 50-alias GraphQL batch costs 1 point and exits 1 when some numbers are missing. | [batch-50-cost-probe-output.json](sources/gh-2.102.0/batch-50-cost-probe-output.json) (`"cost":1`, 14 `NOT_FOUND` errors), [timing-runs.txt](sources/gh-2.102.0/timing-runs.txt) (`exit=1`) | Confirmed. |
| R3 | Exit 8 means "checks pending". | [pr-checks-help-head.txt](sources/gh-2.102.0/pr-checks-help-head.txt) line 10: `8: Checks pending` | Confirmed as *primary* (help text). Not observed live. |
| R4 | `acli search --fields parent,subtasks` is rejected. | [15](sources/acli-1.3.19/15-search-field-not-allowed.txt) | Confirmed. |
| R5 | An Epic `view` returns `subtasks: []`. | [23](sources/acli-1.3.19/23-view-fields-parent-subtasks--epic.json) | Confirmed. |
| R6 | On a Task or Epic, `fields.parent` is `null`. | [21](sources/acli-1.3.19/21-view-fields-issuetype-status-summary-parent-subtasks--task-with-5-subtasks.json), [23](sources/acli-1.3.19/23-view-fields-parent-subtasks--epic.json) | **Corrected.** The `parent` key is **absent**, although `--fields` asked for it. Only a Sub-task has it ([22](sources/acli-1.3.19/22-view-fields-parent-subtasks--subtask.json)). |
| R7 | `--json` with stdout to `/dev/null` fails. | [18](sources/acli-1.3.19/18-view-devnull-stdout-quirk.txt) | Confirmed, with a note. The file shows `exit=0` for the wrapper and `child-exit=1` for acli. acli exits 1. |
| R8 | `$.process.run` rejects with `Executable not found in $PATH`. | [probe-run.2.1.295.json](sources/live-observations-2026-10-10/outputs/probe-run.2.1.295.json); [d.ts:3505](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L3505) | Confirmed. |
| R9 | `SessionRepo.name` is null unless internal; `repo()` may return null. | [d.ts:11463](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L11463), [d.ts:2804](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L2804) | Confirmed. |
| R10 | A `claude -p` prompt has origin `unclassified`. | [subagent-background.json](../claude-code-link-capture/sources/live-observations-2026-10-10/rows/subagent-background.json) (1 `unclassified`, 1 `coordinator`, 4 `task-notification`) | Confirmed. |
| R11 | `acli jira` covers Jira Cloud only. | [help/jira.txt](sources/acli-1.3.19/help/jira.txt) (`Jira Cloud commands.`) | Confirmed for the help text. "Data Center fails" stays *inference*. |
| R12 | A typed REPL prompt is door `prompt`, origin `composer`. | [001-prompt.json](sources/live-observations-2026-10-10/outputs/rows/001-prompt.json) | Confirmed. |
| R13 | The look-behind regex runs in a hooks module. | [probe-globals.txt](sources/live-observations-2026-10-10/outputs/probe-globals.txt) (`"lookbehind":"12"`) | Confirmed. |
| R14 | The literal anchor `#issuecomment-ID` works with `gh issue view`. | [url-forms.txt](sources/gh-2.102.0/url-forms.txt) | **Narrowed.** A literal `ID` gives `no comment url found`. A real numeric id works. |

**Privacy fix.** [batch-50-cost-probe-output.json](sources/gh-2.102.0/batch-50-cost-probe-output.json) held a public spam issue title with a personal name and a bank account number. The review replaced it with `<redacted-spam-title>` before the first commit. The [gh snapshot README](sources/gh-2.102.0/README.md) records it. The Atlassian hosts in [acli-docs-2026-10-10](sources/acli-docs-2026-10-10/README.md) (`ca-csm`, `rovodevagents-beta`, `earlyaccessprogram`, `mysite`) are Atlassian's own public examples. They stay.

## 3. Not yet observed

| # | Question | Why it matters | How to check |
| --- | --- | --- | --- |
| N1 | `gh pr checks` exit 8 (pending) and its value under `--json`. | The parser must not read exit 8 as a failure. | Run on a PR with a running workflow. Read `bucket` either way. |
| N2 | The populated shape of `issueType`. It was `null` in cli/cli, microsoft/vscode and golang/go. | The "type" column for issues. | Find an org with issue types on. `gh issue view N --json issueType`. |
| N3 | `statusCheckRollup` with a `StatusContext` (commit status, not a check run). Only `CheckRun` items were seen. | Older CI posts statuses. | Find a PR with a legacy status. |
| N4 | Batch cost with heavy connection fields (`statusCheckRollup` on 50 PRs). | The rate-limit budget. | Run the batch with `rateLimit { cost }`. |
| N5 | Real GitHub Enterprise: login, API, URL forms. Only a fake host was probed ([ghe-host-probe.txt](sources/gh-2.102.0/ghe-host-probe.txt)). | Decision D15. | Needs a GHE account. |
| N6 | acli 1.3.19 to 1.3.39: flags, field allowlist, error texts. No public notes after 1.3.15. | The installed version nags for an upgrade. | Decision D16. |
| N7 | acli with more than one profile. `ACLI_CONFIG_DIR` per site was not tried. | Decision D13. | A second site, or a second config dir with its own login. |
| N8 | A Jira permission-denied message, and the "site admin must authorize" error after 1.3.15. | Breaker classification. | A restricted item; a site that has not re-authorized. |
| N9 | Hierarchy levels above Epic (Premium). | Tree depth. | A Premium site. |
| N10 | Does `acli --version` reach the network for its "outdated" notice? | It runs in `canRefresh()` probing. | Run it with `HTTPS_PROXY=http://127.0.0.1:9` and time it. |
| N11 | Timer callbacks longer than 45 s. | Long refresh rounds. | Keep each round short; or test 120 s. |
| N12 | Keyboard path into the pane (focus, Tab, Enter on a collapse `Button`). | Tree collapse by key. | tmux run, send keys. **Answered 2026-10-17** (Claude Code 2.1.302, *verified-live*): Tab and Shift+Tab walk every `Button`, Enter presses it, Up and Down scroll when the tree overflows. See [ui: ring walk](../claude-code-mods/reference/ui.md#ring-walk-and-scroll). |
| N13 | A pane in a non-fullscreen terminal. `dock` may need fullscreen (*inference*). | Layout. | Run without fullscreen. |
| N14 | `prompt.submit` for a prompt queued while a turn runs. | Capture choice D4. | tmux run. |
| N15 | Which interactive inputs produce origin `unclassified`. | Allow-list D3. | Log origins over a week of use. |
| N16 | Does `--resume` keep the session id? (Also [link-capture N9](../claude-code-link-capture/open-questions.md).) | Restore from `$.store`. | Log `$.session.id()` across two runs. |
| N17 | Node-count bound for an ordinary `ui.render` tree. Only `Client` trees have 20,000 ([d.ts:1406](../claude-code-mods/sources/claude-code-2.1.295/types/claude-code.d.ts#L1406)). | Big trees. | Draw 5,000 rows in the kit. |
| N18 | Jira URL forms other than `/browse/KEY-N` against a live site (board `selectedIssue`, service desk queues). | Capture rules in [reference-patterns.md](reference-patterns.md). | Collect URLs from the person's own browser history. |
| N19 | A plugin installed from a marketplace (not `--plugin-dir`). A managed `cc-plugin-sec-default` plugin is seated outermost on this machine. | Load order and restore. | Install from a local marketplace. |
| N20 | The `Link` click path on `desktop`, `vscode` and `mobile` (https only per the types). | Links in the pane. | Run on those surfaces. |
| N21 | `tsc` was not run on the probe mod (no `tsc` installed; the KB recipe uses `npx -y`, an install). The kit tests cast with `as never`. | A props-shape error would not show. | Type-check the real mod with the [link-capture tsconfig](../claude-code-link-capture/example/tsconfig.json) pattern. |

## 4. Decisions for the user

Each decision has options and one recommendation. The "why" is short. The pages give the evidence.

| # | Decision | Options | Recommended | Why |
| --- | --- | --- | --- | --- |
| D1 | Which rows count as "mentioned"? | (a) `prompt` + `response` only. (b) (a) plus explicit GitHub and Jira URLs from `tool-result`. (c) Every door, every pattern. | **(b)** | Explicit URLs in tool output are precise. Bare `#N` and web links in tool output are noise ([mod-api-notes §3](mod-api-notes.md#should-tool-result-rows-count-as-mentioned-user-decides)). Keep a `source` field per item. |
| D2 | Bare `#N` match rule. | (a) Any `#N` outside code, with the look-behind rule, resolved against the session repo. (b) (a), but only when a keyword is near (`issue`, `PR`, `pull`, `fix`, `close`, `#N` at a list start). (c) Never bare `#N`; only `owner/repo#N` and URLs. | **(a)** | It matches the requirement. Code masking and the look-behind remove most false positives. `gh` drops numbers that do not exist. Prose like "rank #1" stays a risk; (b) is the fallback ([reference-patterns §3](reference-patterns.md#3-bare-n)). |
| D3 | Which prompt origins are the person's own text? | (a) `composer`, `bridge`. (b) (a) plus `sdk` and `unclassified` (with `!isMeta`). | **(b)** | `claude -p` prompts arrive as `unclassified` (C1). Without them, headless runs track nothing from the person. `!isMeta` drops idle notices. |
| D4 | Capture the person's text by `session.append` rows or by `prompt.submit`? | (a) `session.append` door `prompt`, plus door `command` rows with origin `composer` (parse `<command-args>`). (b) `prompt.submit`. | **(a)** | One code path with the `--resume` backfill from `$.session.messages()`. A `uuid` for dedupe. Slash-command arguments are covered by the `command` rows. |
| D5 | Bare `#N` when the repo is unknown (`repo()` null, no `origin`, not parsable). | (a) Ignore. (b) Keep as "unresolved #N", no link, no refresh. (c) (b), then try `gh repo view --json nameWithOwner` once per session. | **(c)** | `gh` also knows `gh repo set-default` for forks. It is one call per session. |
| D6 | Web link name. | (a) The Markdown label, else host + path. (b) Fetch the page `<title>` with `curl` through `$.process.run`. (c) The URL only. | **(a)** | No network, no privacy leak, no new tool. `fetch` is absent in the hooks module ([probe-globals.txt](sources/live-observations-2026-10-10/outputs/probe-globals.txt)). |
| D7 | Refresh triggers. | (a) On capture + on pane open + `/track refresh`. (b) (a) plus a periodic timer while the pane is open: 5 min, 60 s for PRs with pending checks. (c) (a) plus a periodic timer always. | **(b)** | Fresh data when the person looks. No cost when the pane is closed. One timer with a re-entry guard ([mod-api-notes §5](mod-api-notes.md#5-background-refresh-and-timers)). |
| D8 | Circuit-breaker thresholds. | (a) Per tool: 3 tool failures in a row open it for 5 min; then one probe call (half-open). (b) 5 failures in 10 min open it for 15 min. (c) No breaker; per-item backoff only. | **(a)** | Each call costs about 0.5 to 1.3 s. Three fast failures stop waste quickly. Count only tool failures (auth, network, timeout, start error), never "item not found" ([jira.md §6](jira.md#6-what-the-circuit-breaker-should-count), [github.md §7](github.md#7-what-the-circuit-breaker-should-count)). |
| D9 | Pane behaviour. | (a) Open only by `/track`. (b) Auto-open on the first tracked item. (c) (a) plus a one-line status band with counts. | **(a)** | An unasked open needs at least 110 to 144 columns, else it waits ([mod-api-notes §6](mod-api-notes.md#6-the-pane)). Auto-open steals room. |
| D10 | Persistence across `/clear` and `--resume`. | (a) Keep items across `/clear`; restore on `--resume` from `$.store` and the transcript. (b) Start empty on `/clear`; restore on `--resume`. (c) No persistence. | **(a)** | It is the tested link-capture pattern. `/clear` resets `$.state` but the person usually still works on the same tickets. |
| D11 | Where the plugin lives in this repo. | (a) `plugins/artifact-tracking/` at the repo root. (b) `mods/artifact-tracking/`. (c) Under `docs/knowledge-base/.../example/`. | **(a)** | Code stays out of `docs/`. The folder can later join a marketplace. |
| D12 | Copy or share the link-capture scanner. | (a) Copy `links.ts` into the mod, note the origin, add the bare-`#N` pass there. (b) Import it by relative path from the KB. (c) Rewrite a smaller scanner. | **(a)** | A hooks module may import only its own files ([gotcha 2](../claude-code-mods/gotchas.md)). A path into `docs/` breaks on install. The scanner has 32 tests worth keeping ([reference-patterns §5](reference-patterns.md#5-reuse-the-link-capture-scanner)). |
| D13 | Jira with more than one site. | (a) Never run `acli jira auth switch`. Items on another site are track-only. (b) An opt-in setting that switches the profile. (c) One `ACLI_CONFIG_DIR` per site (untested, N7). | **(a)** | `switch` changes global state for every terminal ([jira.md §7](jira.md#7-sites-auth-and-versions)). |
| D14 | Jira hosts that are not `*.atlassian.net` (Data Center, custom domains). | (a) Track as link-only. (b) Do not track. (c) Try `acli` anyway. | **(a)** | acli is "Jira Cloud commands". A custom domain of a Cloud site can still match if the authenticated site equals the host. |
| D15 | GitHub Enterprise. | (a) v1: `github.com` only for refresh; GHE URLs are track-only. (b) Refresh GHE hosts when `gh auth status --hostname <host>` exits 0. | **(b)** | It costs one `--hostname` probe per host and a `-R host/owner/repo` argument. Untested on a real host (N5), so keep it behind the probe. |
| D16 | acli version. | (a) Design against 1.3.19; record the version; parse defensively; re-run the probes after the person upgrades. (b) A later research step runs 1.3.39 in an isolated copy. (c) The person upgrades now; then re-probe. | **(a)** | No upgrade of the person's tools. An isolated copy needs its own OAuth login, which is a write to auth state. |
| D17 | Jira tree depth. | (a) Root `view` (with `subtasks`); for an Epic, `search parent = EPIC`, then one `view` per child for its sub-tasks. (b) `view` only; Epics show no children. (c) (a) without the per-child step (children only, no grand-children). | **(c)** for v1, **(a)** later | (c) costs 2 calls per Epic. (a) adds about 1 s per child (parallel calls help). |
| D18 | A `github.com` URL that is not an issue or PR (repo, commit, file, Actions run). | (a) Web link. (b) A GitHub item of a new kind. | **(a)** | The spec names issues and PRs only. |
