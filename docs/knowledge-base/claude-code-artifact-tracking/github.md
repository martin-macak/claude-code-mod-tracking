# GitHub: `gh` for issues and pull requests

How the tracking mod finds the type, state and check status of a GitHub issue or PR with `gh`. Pinned to **gh 2.102.0** (2026-09-30), checked live on 2026-10-10 against public `cli/cli`. All commands were read-only.

Evidence lives in [`sources/gh-2.102.0/`](sources/gh-2.102.0/README.md). Tags: *primary* (gh help text or the live GraphQL schema), *observed* (a live run), *inference* (a guess).

Sample numbers: issue `cli/cli#14622` (closed, duplicate), PR `#14640` (open, one failing check), PR `#14633` (merged), PR `#14630` (closed, not merged).

## 1. Summary

| Need | Best call | Tag |
| --- | --- | --- |
| Issue or PR? | GraphQL `issueOrPullRequest(number:)` `__typename`, or `gh issue view N --json url` (path `/pull/` or `/issues/`) | *observed* |
| State | Issue `state` + `stateReason`. PR `state` (`OPEN`, `CLOSED`, `MERGED`) + `isDraft` | *primary*, *observed* |
| Checks | GraphQL `statusCheckRollup { state }` on the last commit, or `gh pr checks --json bucket` | *observed* |
| Many items | One batched GraphQL query with aliases. 50 items cost 1 rate point, about 1.3 s | *observed* |
| Is `gh` usable? | `gh --version` (34 ms) for presence. A real call's exit code for auth | *observed* |

## 2. Issue or PR in one call

| Method | Result | Evidence |
| --- | --- | --- |
| REST `gh api repos/O/R/issues/N` | The JSON has a `pull_request` key only for a PR. | [type-rest-issue.txt](sources/gh-2.102.0/type-rest-issue.txt), [type-rest-pr.txt](sources/gh-2.102.0/type-rest-pr.txt) *observed* |
| GraphQL `repository { issueOrPullRequest(number: N) { __typename } }` | `Issue` or `PullRequest`. Batchable by alias. `gh issue view` sends this field itself. | [batch-query-sample-output.json](sources/gh-2.102.0/batch-query-sample-output.json), [timing-issue-view-debug.txt](sources/gh-2.102.0/timing-issue-view-debug.txt) *observed* |
| `gh issue view N --json url` | Accepts a PR number. The `url` ends in `/pull/N` for a PR, `/issues/N` for an issue. | [type-via-url-field.txt](sources/gh-2.102.0/type-via-url-field.txt) *observed* |
| `gh pr view N` on an issue number | Fails: `Could not resolve to a PullRequest`, exit 1. | [type-wrong-type-cli.txt](sources/gh-2.102.0/type-wrong-type-cli.txt) *observed* |
| `gh issue view N --json isDraft` on a PR | Fails, exit 1. `isDraft` is not an issue field. | [issue-view-on-pr-isdraft.txt](sources/gh-2.102.0/issue-view-on-pr-isdraft.txt) *observed* |

Rule: never trust the URL path or the scanner for the type. Take the type from `__typename`. A `/issues/N` URL may point to a PR, because GitHub redirects it (*inference*; only the reverse, `issue view` on a `/pull/` URL, was observed). The scanner also builds `/issues/N` for every `owner/repo#N`.

## 3. Fields

From `gh issue view --help`, `gh pr view --help` and the live schema ([json-fields-help.txt](sources/gh-2.102.0/json-fields-help.txt), [graphql-enum-introspection.txt](sources/gh-2.102.0/graphql-enum-introspection.txt)). *primary*

| Item | Field | Values |
| --- | --- | --- |
| Issue | `state` | `OPEN`, `CLOSED` |
| Issue | `stateReason` | `COMPLETED`, `NOT_PLANNED`, `DUPLICATE`, `REOPENED`, or null |
| Issue | `issueType` | null in every sample (cli/cli, microsoft/vscode, golang/go). Populated shape unknown ([issue-type-samples.txt](sources/gh-2.102.0/issue-type-samples.txt), [open N2](open-questions.md#3-not-yet-observed)). |
| Issue | also | `title`, `labels`, `author`, `closedAt`, `url`, `subIssues`, `parent`, `blockedBy`, `blocking` |
| PR | `state` | `OPEN`, `CLOSED`, `MERGED` |
| PR | `isDraft` | boolean |
| PR | `reviewDecision` | `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null |
| PR | `mergeStateStatus` | e.g. `BLOCKED` (PR 14640) |
| PR | `statusCheckRollup` | `StatusState`: `EXPECTED`, `ERROR`, `FAILURE`, `PENDING`, `SUCCESS` |

An unknown `--json` field fails with exit 1 and lists the valid fields ([issue-view-bad-field.txt](sources/gh-2.102.0/issue-view-bad-field.txt)). *observed*

Samples: [issue-view-14622.txt](sources/gh-2.102.0/issue-view-14622.txt), [pr-view-14640-open.txt](sources/gh-2.102.0/pr-view-14640-open.txt), [pr-view-14633-merged.txt](sources/gh-2.102.0/pr-view-14633-merged.txt), [pr-view-14630-closed.txt](sources/gh-2.102.0/pr-view-14630-closed.txt). A merged PR has `state: MERGED`. A closed, unmerged PR has `state: CLOSED` and `mergedAt: null`.

Suggested display status (*inference*): issue → `open`, `closed` (`completed`), `closed` (`not planned`), `closed` (`duplicate`). PR → `draft`, `open`, `merged`, `closed`, plus a checks badge `pass`, `fail`, `pending`.

## 4. Checks

| Way | Behaviour | Evidence |
| --- | --- | --- |
| `gh pr checks N` (plain) | Exit 1 when a check failed. Exit 0 when only `pass` or `skipping`. | [pr-checks-14640-plain.txt](sources/gh-2.102.0/pr-checks-14640-plain.txt), [pending-search.txt](sources/gh-2.102.0/pending-search.txt) *observed* |
| `gh pr checks N --json name,state,bucket` | **Exit 0 even when a check failed.** Read `bucket`. | [pr-checks-14640-json-bucket.txt](sources/gh-2.102.0/pr-checks-14640-json-bucket.txt), [jq-fail-count](sources/gh-2.102.0/pr-checks-14640-json-jq-fail-count.txt) *observed* |
| `bucket` values | `pass`, `fail`, `pending`, `skipping`, `cancel` | [pr-checks-help-head.txt](sources/gh-2.102.0/pr-checks-help-head.txt) *primary* |
| Exit 8 | "Checks pending" (help, line 10). Not observed live. Its value with `--json` is unknown. | *primary*; [open N1](open-questions.md#3-not-yet-observed) |
| Cost | `gh pr checks` sends 4 GraphQL requests (paging contexts). About 1.15 s. | [gh README](sources/gh-2.102.0/README.md), [timing-runs.txt](sources/gh-2.102.0/timing-runs.txt) *observed* |
| Rollup in GraphQL | `commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }` gives one state per PR. PR 14640 gives `FAILURE`. | [batch-query-sample.graphql](sources/gh-2.102.0/batch-query-sample.graphql), [output](sources/gh-2.102.0/batch-query-sample-output.json) *observed* |
| `statusCheckRollup` items | Only `CheckRun` items were seen (`conclusion`, `status`, `name`, `workflowName`, `detailsUrl`). No `StatusContext`. | [pr-view-14640-rollup.txt](sources/gh-2.102.0/pr-view-14640-rollup.txt) *observed* |

Recommendation (*inference*): use the rollup `state` in the batch for the table. Call `gh pr checks --json` only when the person expands a PR row to see each check.

## 5. Batching and cost

| Fact | Evidence |
| --- | --- |
| One `gh issue view` = 1 GraphQL request. One `gh pr view` = 1. One `gh pr checks` = 4. | [timing-issue-view-debug.txt](sources/gh-2.102.0/timing-issue-view-debug.txt), [gh README](sources/gh-2.102.0/README.md) *observed* |
| A 50-alias `issueOrPullRequest` query costs **1 point** (`rateLimit { cost }`). | [batch-50-cost-probe.graphql](sources/gh-2.102.0/batch-50-cost-probe.graphql), [output](sources/gh-2.102.0/batch-50-cost-probe-output.json) *observed* |
| Missing numbers give `null` plus one `NOT_FOUND` error per alias. **Exit 1**, but stdout still holds the other aliases. | same files, [stderr](sources/gh-2.102.0/batch-50-cost-probe-stderr.txt) *observed* |
| Wall time, 5 runs: `issue view` ≈ 0.46 s, `pr view` ≈ 0.71 s, `pr checks` ≈ 1.15 s, REST issue ≈ 0.47 s, 3-alias batch ≈ 1.0 s, 50-alias batch ≈ 1.3 s. | [timing-runs.txt](sources/gh-2.102.0/timing-runs.txt) *observed* |
| Limits: `core` and `graphql` each 5000 per hour for this token. Shape: `{ resources: { core, graphql, search, … }, rate }`. | [gh-version-and-rate-limit.txt](sources/gh-2.102.0/gh-version-and-rate-limit.txt) *observed* |
| `gh api rate_limit` lagged once. Put `rateLimit { cost remaining }` in the query for exact numbers. | researcher note *observed* |

Batch query shape (one alias per item; group by repo):

```graphql
query {
  rateLimit { cost remaining }
  i0: repository(owner: "cli", name: "cli") {
    issueOrPullRequest(number: 14640) {
      __typename
      ... on Issue { number title state stateReason url }
      ... on PullRequest { number title state isDraft reviewDecision url
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }
}
```

Run it as `['gh', 'api', 'graphql', '-f', 'query=' + text]` (the form used in the probes; no shell needed). Parse stdout as JSON on **any** exit code. Then read `errors[]` per alias. The cost of heavy fields on 50 PRs is not measured ([open N4](open-questions.md#3-not-yet-observed)).

## 6. Auth and errors

Exit codes: 0 success, 1 failure, 2 cancelled, 4 authentication required ([gh-help-exit-codes.txt](sources/gh-2.102.0/gh-help-exit-codes.txt)). `gh pr checks` adds 8 (pending). *primary*

| Case | Exit | Message | Evidence |
| --- | --- | --- | --- |
| Logged in | 0 | `gh auth status` lists the account and scopes (`gist`, `read:org`, `repo`). Token masked. | [auth-status-normal.txt](sources/gh-2.102.0/auth-status-normal.txt) |
| No credentials (`GH_CONFIG_DIR` empty) | 4 | `To get started with GitHub CLI, please run: gh auth login`. **Even for a public repo.** `gh auth status` exits 1. | [auth-unauth-issue-view.txt](sources/gh-2.102.0/auth-unauth-issue-view.txt), [auth-unauth-api-public.txt](sources/gh-2.102.0/auth-unauth-api-public.txt), [auth-unauth-status.txt](sources/gh-2.102.0/auth-unauth-status.txt) |
| Bad `GH_TOKEN` | 1 | `HTTP 401: Bad credentials`. `gh auth status`: `The token in GH_TOKEN is invalid.` | [auth-bad-token-issue-view.txt](sources/gh-2.102.0/auth-bad-token-issue-view.txt), [auth-bad-token-status.txt](sources/gh-2.102.0/auth-bad-token-status.txt) |
| Issue number missing | 1 | `Could not resolve to an issue or pull request with the number of N` | [not-found-issue-number.txt](sources/gh-2.102.0/not-found-issue-number.txt) |
| Repo missing | 1 | `Could not resolve to a Repository`; REST gives HTTP 404 | [not-found-repo-issue-view.txt](sources/gh-2.102.0/not-found-repo-issue-view.txt), [not-found-repo-rest.txt](sources/gh-2.102.0/not-found-repo-rest.txt) |
| Host unreachable | 1 | `error connecting to <host>` | [ghe-host-probe.txt](sources/gh-2.102.0/ghe-host-probe.txt) |

The unauthenticated state was simulated with an empty `GH_CONFIG_DIR`. A fresh install may differ slightly. *observed*

## 7. What the circuit breaker should count

*Inference* from §6:

| Outcome | Breaker | Item |
| --- | --- | --- |
| `$.process.run` rejects (not on PATH, timeout) | count | unchanged |
| Exit 4 | count; also mark "gh not logged in" so `canRefresh()` turns false until a manual refresh | unchanged |
| Exit 1 with `HTTP 401` or `error connecting` | count | unchanged |
| Exit 1 with `Could not resolve to an issue or pull request` | **do not count** | mark `not-found` (likely a false `#N`) |
| Exit 1 with `Could not resolve to a Repository` | do not count | mark `repo-not-found` |
| Batch exit 1 with valid JSON on stdout | do not count | apply per-alias data and errors |
| `gh pr checks --json` exit 0 | success | read `bucket` |
| Exit 8 | success | checks `pending` |

## 8. Which repo a number belongs to

| Case | Behaviour | Evidence |
| --- | --- | --- |
| Project dir with SSH `origin` | `gh repo view --json nameWithOwner` gives `<owner>/claude-code-mod-tracking`. | [repo-resolution-project-dir.txt](sources/gh-2.102.0/repo-resolution-project-dir.txt) *observed* |
| Dir with no remote | `gh repo view` and `gh issue view N` fail: `no git remotes found`, exit 1. | [repo-resolution-no-remote.txt](sources/gh-2.102.0/repo-resolution-no-remote.txt) *observed* |
| `GH_REPO=cli/cli` | The number form works anywhere. | same *observed* |
| `owner/repo#N` as argument | Rejected: `invalid issue format`, exit 1. Use `-R owner/repo`, `GH_REPO` or the URL. | same *observed* |
| A full URL | Works from any directory. | same *observed* |

The mod should resolve the repo itself (from `$.session.repo()` and `parseRemote`, see [mod-api-notes §4](mod-api-notes.md#4-sessionrepo)) and always pass `-R owner/repo` or use GraphQL with explicit `owner` and `name`. Do not depend on the cwd of `gh`. *inference*

## 9. URL forms `gh` accepts

From [url-forms.txt](sources/gh-2.102.0/url-forms.txt). *observed*

| URL | `gh pr view` / `gh pr checks` | `gh issue view` |
| --- | --- | --- |
| `…/pull/N`, `…/pull/N/files`, `…/pull/N/checks` | works | `…/pull/N` works (returns the PR) |
| `…/issues/N`, trailing `/` | **fails**: read as a branch name, exit 1 | works |
| `…/issues/N#issuecomment-<number>` | | works (a literal `ID` fails: `no comment url found`) |

The mod should normalize every URL to `owner`, `repo`, `number` and never pass the raw URL. See [reference-patterns §2](reference-patterns.md#2-explicit-github-urls).

## 10. GitHub Enterprise

| Fact | Tag |
| --- | --- |
| `GH_HOST`, or a host in the URL, sends the call to that host. Env vars `GH_HOST`, `GH_ENTERPRISE_TOKEN`, `GH_REPO`, `GH_CONFIG_DIR`, `GH_DEBUG` are documented ([gh-help-environment.txt](sources/gh-2.102.0/gh-help-environment.txt)). | *primary* |
| A fake host gave `error connecting`, exit 1 (with `GH_HOST`), or exit 4 (host in URL, no login) ([ghe-host-probe.txt](sources/gh-2.102.0/ghe-host-probe.txt)). | *observed* |
| Real GHE login, API paths and URL forms. | *inference*, untested ([open N5](open-questions.md#3-not-yet-observed)) |

Recommendation: probe `gh auth status --hostname <host>` once per host. Refresh only on exit 0. See decision D15 in [open-questions](open-questions.md#4-decisions-for-the-user).

## 11. Privacy

`gh` output holds author logins, names, and titles. Spam issues may hold personal data. The mod keeps only the fields the table shows. It never stores raw output in `$.store`.
