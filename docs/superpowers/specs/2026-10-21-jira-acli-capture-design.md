# Track Jira items from `acli` commands

## Problem

The mod tracks a Jira item only from a `…/browse/KEY` URL. A session often names a ticket by its bare key (`TEAL-2071`) and reads it with `acli jira workitem view TEAL-2071`. Neither output holds a URL, so the item never appears in `/track`.

## Goal

An `acli jira workitem <sub> KEY` command in a Bash tool call tracks `KEY` on acli's active site.

## Out of scope

- Bare keys in prompts and replies. They risk false hits such as `UTF-8` and `SHA-256`.
- Keys from `acli jira workitem search`, and any command that names more than one key or uses `--jql`.
- Jira MCP tool calls.

## Design

### Capture

The Jira kind reads Bash tool calls: `jiraKind.fromTool.Bash` (`trackers/jira/kind.ts`). The pure parser is `acliWorkitems` (`trackers/jira/acli-command.ts`).

1. Split the command into simple commands with `splitShell` (`core/lib/shell.ts`). It keeps quoted text in one word. Drop the reserved words and wrappers in front of each part with `stripLead` (`if`, `then`, `do`, `!`, `time`, `sudo`, `env`, `command`, `nohup`, `VAR=x`), as the other readers of `splitShell` do.
2. A part counts when it starts with `acli jira workitem <sub>` and `<sub>` is `view`, `comment`, `edit`, `assign`, `transition`, `clone`, `archive` or `unarchive`. `search`, `create`, `delete` and `link` name no single tracked item. The `acli` word may carry a path.
3. The key comes from one of two places. `view` takes the one word that has the shape of a key. The other sub-commands take it as the value of `--key` or `-k`, as `--key KEY`, `--key=KEY`, `-k KEY`, `-kKEY` or `-k=KEY`. A word glued to `-k` counts only when it is a key (`--body "-kind"` is text). It must match `JIRA_KEY` as typed: `utf-8` is not a key, and Jira writes keys in upper case. A comma list (`--key "A-1,B-2"`) names more than one key, and so do a `view` with two different keys and a command with two different `--key` values (acli keeps the last value of a repeated flag, so no single item is clear): all of these add nothing. Quotes are stripped.
4. A denied call, or one the tool reported as an error, adds nothing. The result check is the one `trackers/repos/index.ts` already has. A failing `acli` call often means an unknown key, and tracking it would show a row that can never refresh. The limit: the mod sees one exit status for the whole Bash command, so an `acli` call that fails behind a pipe, a `;` or `|| true` (`acli jira workitem view NOPE-1 | head`) still tracks its key, and that row shows `not found`.

### Site

acli works on its active site only. The handler calls `loadActiveSite()` (cached, one shared call) and builds the ref of `https://<site>/browse/KEY` with `parseJiraUrl`. It builds the claim with the same helper as `claimUrl` (`claimOf`), so the key is the key of a URL mention, and `merge`, dedup, persistence, refresh and priority need no change.

No active site (not installed, not logged in, breaker open) means nothing is tracked. The Jira section already says why.

The first acli call of a session waits for that lookup, and the tool hook holds the result of the call meanwhile. A Jira URL in a tool result (`accept`) and a stored copy (`restore`) wait for the same lookup. The wait is bounded by `global.tools.timeoutMs` and the breaker, and shared by the callers that ask at once. A site or a "not logged in" answer is cached. A lookup that fails for another reason (a timeout, a crash of acli) is asked again by the next acli call, until the breaker opens. A load does not warm the lookup (only the restore of a stored copy asks), because a new session with acli installed must make no call beyond the version probe (`tests/toggles.test.ts`). A replay of a transcript with an acli use waits for the same one lookup.

### Reason

The reason list is closed, so none is added.

Owner decision of 2026-10-21 (issue #149): a command that changes the item claims `updated`, because the reason list says `updated` is "Claude changed it", and the `t` key of the pane (issue #63) hides rows whose strongest reason is `mentioned`.

| Sub-command | Reason |
| --- | --- |
| `view`, `comment list` | `read` |
| `edit`, `assign`, `transition`, `comment` (other than `list`), `archive`, `unarchive` | `updated` |
| `clone` (it makes a new item and leaves the source as it was) | `mentioned` |

### Errors

The handler never throws. A parse that fails adds nothing. Each call is isolated by the bus.

## Acceptance criteria

1. GIVEN a logged-in acli on site `acme.atlassian.net`, WHEN Bash runs `acli jira workitem view TEAL-2071`, THEN `/track` shows `TEAL-2071` with reason `read`.
2. GIVEN the same site, WHEN Bash runs `acli jira workitem transition --key TEAL-2071 --status Done`, THEN `TEAL-2071` is tracked with reason `updated`. (Owner decision of 2026-10-21: it was `mentioned`. `clone` keeps `mentioned`.)
3. GIVEN `acli jira workitem search --jql "assignee = currentUser()"`, THEN nothing is tracked.
4. GIVEN a chained command `cd x && acli jira workitem view ABC-1 | head`, THEN `ABC-1` is tracked once.
5. GIVEN an acli call that fails or is denied, THEN nothing is tracked.
6. GIVEN acli is not logged in, THEN nothing is tracked and the Jira section shows its existing message.
7. GIVEN `TEAL-2071` was already tracked from its URL, WHEN `acli jira workitem view TEAL-2071` runs, THEN one item remains, with both sources.
8. GIVEN the argument `utf-8`, a malformed key, or `--key "A-1,B-2"`, THEN nothing is tracked.

## Tests

Test first. Each criterion above has one test that fails without the change.

- Unit tests for the command parser (`trackers/jira`): accepted and rejected sub-commands, chains, flags before and after the key, quoting, case, a reserved word or a wrapper in front of `acli`, one key for `view`, the reason of each sub-command.
- Kit tests for the handler: site resolved, no site, acli not installed, failed call, denied call, replay, the wait for the shared site lookup, dedup against a URL mention, the turn ledger (issue #133), the status token and facets of the row and the `t` filter (issue #63).

## Docs

- Add the `acli` rows to the capture table in `plugins/artifact-tracking/README.md`.
- Add the `acli` source to the reasons table.
