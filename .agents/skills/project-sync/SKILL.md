---
name: project-sync
description: Use when you must pick the next item of work, start or finish an issue or PR, file or place a new issue, or change the Status of an item in this repo's GitHub Project, or when the project looks stale after a blocker closed or an issue was added by hand.
---

# Project sync

Keep the GitHub Project in step with the issues, and pick work from it. The project facts and the duties at each step are in `AGENTS.md`, "Planning and delivery". This skill holds the commands.

**Core rule:** the native "blocked by" links are the source. The script computes Wave, Status and "Blocked by" from them, shows a plan, and writes it only with `--apply`. It never computes `Order`.

## Run it

```bash
node .agents/skills/project-sync/scripts/sync.mjs <command> [options]
make project-sync ARGS='<command> [options]'    # the same; ARGS defaults to "sync"
```

Node 24, no install. The defaults are `--owner martin-macak --project 3 --repo martin-macak/claude-code-mod-tracking`. The blocker commands of this skill need gh 2.94 or newer. `--json` prints one JSON document on stdout: `changes`, `applied`, `positions`, `moved`, `positionsLeft`, `positionsUnverified`, `cycles`, `inversions`, `missingFromProject`, `noStatus`, `warnings`, `options` (the options of Status, Wave, Release and Area) and `items`. `positionsLeft` counts the listed items that are still out of position after the moves. It is `null` when no check ran: a dry run, or a `sync` or `next` that wrote no move. `add --apply` of a new item always checks, also when no move was written. `positionsUnverified` is `null`, or the problems of the read after the writes when it was not complete: the writes stay, the places were not checked, and the exit code is 1. So `positionsLeft: null` together with an array here means that a check ran and failed, not that none was due. `next` adds `next` and `ready`; both are `null` when a dry run read an incomplete project. `add` adds `added` (`number`, `itemId`, `kind`, `title`, `existed`, `set`, and `unlisted`). `status` prints `item`, `from`, `to` and `written`.

| Command | What it does |
| --- | --- |
| `sync [--apply]` | Plans Wave, Status and "Blocked by" for the open issues, and the item positions. Prints the report. A dry run. `--apply` writes the field changes, then the position moves. |
| `next [--apply]` | Runs `sync`, then prints the item to pick (the Pick duty in `AGENTS.md`). Drafts count. PRs do not. A dry run that read an incomplete project prints no pick (`No pick: the read was incomplete.`): a short list can lack the right item. It reads the Status that `sync` would write. `--apply` writes the plan first, as `sync` does. |
| `add <number\|url> --order N --area A --release R [--status S] [--apply]` | Without `--apply` it writes nothing. It reads and plans first, and prints the plan with the item built in memory ("Would add"). With `--apply` it adds the item (an item that is in the project already is not added again) and sets Order, Area and Release with the item id that the add returns. It does not wait for the item in the project list: GitHub may list a new item minutes late. Then it runs the same sync as `sync --apply`, for the whole project. After the writes it reads the list once per try and checks the places of the items that the list shows, also when no move was needed. When the list still lacks the new item, it cannot check the place of that item. It says so on stderr, exits 0, and `--json` gives `added.unlisted: true`. Run `sync` later to check. An item that is listed and still out of position exits 1, as in `sync`. A PR gets `In review`, unless `--status` says otherwise. `--status Done` is refused. |
| `status <number\|"draft title"> <Status>` | Sets the Status of one item at once. A draft item is found by its title (the whole title, or one unique part of it). It refuses `Done`, because GitHub sets it, and it refuses an empty item (exit 2). |

Exit codes: 0 done, 1 error, 2 wrong usage, 3 the token cannot read or write the project. Exit 1 also covers the refusal to write from an incomplete read ("Complete reads" below): nothing was written, and the same command can run again a minute later.

## Rules of `sync`

- It handles open issue items only. PRs, draft items and closed issues stay as they are.
- **Wave.** As `AGENTS.md` defines it ("Fields"). It follows the native links, also through issues that are not in the project. A closed blocker does not count. GitHub may fail to resolve a blocker outside the project. That blocker counts as open with no blockers, and the run prints a warning. If the option `Wave N` is missing, the run stops and says that the owner must add it.
- **Status.** An open blocker gives `Blocked`. No open blocker gives `Ready` when the Status is `Blocked` or empty. It writes Status only when the current value is `Blocked`, `Ready` or empty. It never touches `In progress`, `In review` or `Done`.
- **Blocked by.** The format is in `AGENTS.md` ("Fields"). The numbers go ascending, and `—` (U+2014) stands for none. A note stays when its issue numbers equal the open blockers.
- **Positions.** The manual order of the items follows `Order`: ascending Order. A tie goes issue, PR, draft, then by number or title. Items with no Order go last, in their current relative order.
- **Complete reads.** GitHub's project API sometimes answers with part of the items, or none, and gives no error (issue #228). On 2026-10-22 reads seconds apart gave 0, 100 and 105 items of about 109, and once the item count itself said 0. A plan from such a list is wrong, and so are its writes. Every read asks for the item count (`totalCount`) with the items. A read is complete when its items are all different, as many as `totalCount` (the same on every page), and at least one. An empty project is a bad read: this project is never empty.
  - **Writes.** `sync --apply`, `next --apply`, `add --apply` and `status` read the project twice, and both reads must list the same items with the same titles, field values and blockers. A real edit between the two reads, which come less than a second apart, only costs a new try. A bad read is tried again, up to four tries in all, with a pause of 0.5, 1 and 2 seconds between them. When the last try is still bad, the command exits 1 before it plans or writes anything. The message names the counts: the items listed, `totalCount`, or the items that only one read has. It says that nothing was written.
  - **After the writes.** The check of the positions reads once per try, with the same tries and pauses. The read must be complete and list every item that the plan saw. If no try is complete, the writes stay, the places are not checked, and the exit code is 1. `--json` then has the problems in `positionsUnverified`. Run `sync` later.
  - **Dry run.** It reads once per try: one read when the read is good, and a bad read is tried again as above (four tries, 3.5 seconds of pauses). It still prints the plan, but an incomplete read gives a warning on stderr, an entry in `warnings` of `--json`, and a line under the report. Do not trust that plan. `--apply` would refuse it.
- **How positions are written.** The script reads the items in position order (`orderBy: POSITION`) and works out the fewest moves. `--apply` writes each move with the GraphQL mutation `updateProjectV2ItemPosition`: the moved item goes after its predecessor in the sequence, and the first item goes to the top. Then it reads the project again and checks the order. If the order differs, it exits 1.
- **Report.** Cycles (their issues and the issues that wait for them get no Wave), Order inversions (an issue ordered before its open blocker), open issues of every open milestone of the repo that are not in the project, items with no Status that the plan cannot fill (PRs, drafts, closed issues), and how many items are out of position.

## Work with it

1. Run `sync` or `next` first. Read the plan.
2. With a token that has the `project` scope, run `sync --apply` when every change is expected (a blocker closed, an issue was added). A cycle or an Order inversion is for the owner: report it, and do not change `Order` to hide it.
3. Move an item with `status`, at the steps that the Duties in `AGENTS.md` list.
4. Stack layers (`AGENTS.md`, "Planning and delivery", "Stack layers"): the sub-issue of a layer is its item, and the layer PR is none. Read the draft's Order, Area and Release from `items` in `sync --json`. Run `add --apply` for the sub-issue with the same values (the workflow may have added it already; `add` keeps the item and sets the fields). Then delete the draft: `gh project item-delete 3 --owner martin-macak --id <draft item id>` (`items[].id`).

## Place a new issue

The issue skills (`issue-bug`, `issue-enhancement`) do this before they create an issue.

1. Read the options and the Order of the open items:

   ```bash
   node .agents/skills/project-sync/scripts/sync.mjs sync --json | jq -r '.warnings[], .options, (.items | sort_by(.fields.Order) | .[] | "\(.fields.Order)\t\(.kind)\t\(.number // "-")\t\(.title)")'
   ```

   A warning that the read looks incomplete (issue #228) means the list may lack items. Run it again a minute later, and choose the `Order` from a list that has no such warning.

2. Ask the user for the milestone, the blockers, the Area and the Order. For `Release`, use the rule in `AGENTS.md` ("Fields"). For `Order`, choose a number between two neighbours.
3. Create the issue with the native links: `gh issue create ... --milestone "<title>" --blocked-by <n>[,<n>]`.
4. Place it, with the number from the URL that `gh issue create` printed:

   ```bash
   node .agents/skills/project-sync/scripts/sync.mjs add <number> --order <n> --area <area> --release <release> --apply
   ```

   It adds the item, sets Order, Area and Release, then syncs the whole project, so other items can change too. Read the report. Without `--apply` it writes nothing and prints the plan.

## No access to the project

`sync`, `next`, `add` and `status` need a `gh` token. Who may write, and the fallback order without access: `AGENTS.md`, "Planning and delivery" ("Who writes", "No access").

When the project cannot be read, the script prints the reason and that fallback order, and exits 3. The commands for it:

- `gh issue list --milestone "<title>"` lists the issues of a milestone.
- `gh issue view <n> --json blockedBy` lists the native blockers (gh 2.94 or newer). `blockedBy.nodes[].state` is `OPEN` or `CLOSED`.
- `gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by --jq '.[] | select(.state == "open") | .number'` lists the open blockers on any gh.

What was observed: without any token, REST returns the project itself (HTTP 200) but not its items ("Requires authentication", HTTP 401).

## Views

Change a view by creating a new one and deleting the old one (`AGENTS.md`, "Planning and delivery", "Views"). It needs the `project` scope.

- Create: `gh api --method POST /users/<login>/projectsV2/<n>/views --input <json>`. The body has `name`, `layout` (`table`, `board` or `roadmap`), `filter`, `visible_fields`, `group_by`, `sort_by` (`[[field_id, "asc"]]`) and `vertical_group_by`.
- Field ids are the REST ids from `gh api /users/<login>/projectsV2/<n>/fields`.
- The path takes the login. The numeric user id returns 404 (observed).
- Delete: the GraphQL mutation `deleteProjectV2View(input: {viewId})`.
- Read the settings of a view: the GraphQL fields `groupByFields`, `sortByFields` and `verticalGroupByFields` of the view.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| `--apply` with a plan you did not read | Run the dry run first. Apply only the changes you expect. |
| Trusting a dry run that shows `Items: 0`, a low item count, or "missing from the project" for issues that you know are in it | The read may be incomplete (issue #228). Look for the warning about it. Run the dry run again a minute later. Plan from a read that has no warning only. |
| Forcing a write after `refusing to write: the read ... is not complete` | Do not. The refusal is the safe result: nothing was written. Wait a minute and run the command again. If it repeats, report it. Do not write the fields by hand from the plan of that read. |
| Running `add` without `--apply` and expecting the item in the project | `add` is a dry run too. Read "Would add", then run it again with `--apply`. |
| Running `add --apply` again because `item-list` or the project page does not show the new item | Do not. GitHub lists a new item late, for minutes (issue #107). `add --apply` sets its fields with the item id that the add returns, so the item is complete when the run ends. Read it with the GraphQL `node(id:)` query (the id is `added.itemId` of `--json`): `gh api graphql -f query='{ node(id:"<added.itemId>") { ... on ProjectV2Item { id isArchived content { ... on Issue { number } ... on PullRequest { number } } } } }'`. Or run `sync` later. |
| Setting `Order` or `Done` by hand | Do not. See the Duties and "Fields" in `AGENTS.md`. `status` refuses `Done`. |
| Typing a blocker only in the "Blocked by" text | Add the native link (`gh issue edit <n> --add-blocked-by <b>`). `sync` rewrites the text from the links. |
| Dragging items in the web UI and expecting the order to stay | `sync --apply` moves each item back to the place that `Order` gives. Change `Order` instead. |
| Fixing a cycle by deleting the project item | A cycle is in the native links. Report it to the owner. |
| Hard-coding project, field or option IDs | The script reads them by name at run time. |
| Picking from the project when it cannot be read | Use the fallback order in `AGENTS.md` ("No access"). |
