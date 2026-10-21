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

The Jira tracker registers a `toolCall.Bash` handler.

1. Split the command into simple commands with `splitShell` (`core/lib/shell.ts`). It keeps quoted text in one word.
2. A part counts when it starts with `acli jira workitem <sub>` and `<sub>` is `view`, `comment`, `edit`, `assign`, `transition`, `clone`, `archive` or `unarchive`. `search`, `create`, `delete` and `link` name no single tracked item. The `acli` word may carry a path.
3. The key comes from one of two places. `view` takes it as the first positional argument. The other sub-commands take it as the value of `--key` or `-k`, as `--key KEY`, `--key=KEY` or `-k KEY`. It must match `JIRA_KEY` as typed: `utf-8` is not a key, and Jira writes keys in upper case. A comma list (`--key "A-1,B-2"`) names more than one key, so it adds nothing. Quotes are stripped.
4. A denied call, or one the tool reported as an error, adds nothing. The result check is the one `trackers/repos/index.ts` already has. A failing `acli` call often means an unknown key, and tracking it would show a row that can never refresh.

### Site

acli works on its active site only. The handler calls `loadActiveSite()` (cached, one shared call) and builds `https://<site>/browse/KEY`. It sends that URL through the existing `claimUrl`, `accept` and `merge` path. Dedup, persistence, refresh and priority need no change.

No active site (not installed, not logged in, breaker open) means nothing is tracked. The Jira section already says why.

### Reason

The reason list is closed, so none is added.

| Sub-command | Reason |
| --- | --- |
| `view`, `comment list` | `read` |
| any other accepted sub-command | `mentioned` |

### Errors

The handler never throws. A parse that fails adds nothing. Each call is isolated by the bus.

## Acceptance criteria

1. GIVEN a logged-in acli on site `acme.atlassian.net`, WHEN Bash runs `acli jira workitem view TEAL-2071`, THEN `/track` shows `TEAL-2071` with reason `read`.
2. GIVEN the same site, WHEN Bash runs `acli jira workitem transition --key TEAL-2071 --status Done`, THEN `TEAL-2071` is tracked with reason `mentioned`.
3. GIVEN `acli jira workitem search --jql "assignee = currentUser()"`, THEN nothing is tracked.
4. GIVEN a chained command `cd x && acli jira workitem view ABC-1 | head`, THEN `ABC-1` is tracked once.
5. GIVEN an acli call that fails or is denied, THEN nothing is tracked.
6. GIVEN acli is not logged in, THEN nothing is tracked and the Jira section shows its existing message.
7. GIVEN `TEAL-2071` was already tracked from its URL, WHEN `acli jira workitem view TEAL-2071` runs, THEN one item remains, with both sources.
8. GIVEN the argument `utf-8`, a malformed key, or `--key "A-1,B-2"`, THEN nothing is tracked.

## Tests

Test first. Each criterion above has one test that fails without the change.

- Unit tests for the command parser (`trackers/jira`): accepted and rejected sub-commands, chains, flags before and after the key, quoting, case.
- Kit tests for the handler: site resolved, no site, failed call, dedup against a URL mention.

## Docs

- Add the `acli` rows to the capture table in `plugins/artifact-tracking/README.md`.
- Add the `acli` source to the reasons table.
