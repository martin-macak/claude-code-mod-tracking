# gh 2.102.0 snapshot

Live output from `gh` 2.102.0 (`/opt/homebrew/bin/gh`), captured 2026-10-10 on macOS (zsh).
Read-only commands only. No login, logout, install, or write to any GitHub object.

Sample repo: `cli/cli` (public). Sample numbers:

- Issue `#14622` (closed, `stateReason` DUPLICATE).
- PR `#14640` (open, checks mixed: one `fail`, 11 `pass`, 8 `skipping`).
- PR `#14633` (merged).
- PR `#14630` (closed, not merged).

Tag the claims from these files as `observed` unless a row says otherwise.

Redactions: the GitHub login is replaced with `<account>` in the auth outputs. The token is masked by gh itself. One email address inside a spam issue title is replaced with `<redacted-email>` in `batch-50-cost-probe-output.json`. The title of spam issue 14613 in the same file held a personal name and a bank account number; it is replaced with `<redacted-spam-title>` (synthesis review, before first commit).

Files marked "(-- trimmed)" are cut to the relevant part.

## Version, auth and rate limit

| File | Command (run from `/private/tmp`) | Notes |
| --- | --- | --- |
| `gh-version-and-rate-limit.txt` | `gh --version`; `gh api rate_limit --jq '{core, graphql, rate}'` | Rate-limit shape. |
| `auth-status-normal.txt` | `gh auth status` | Logged-in state. Exit 0. |
| `auth-bad-token-status.txt` | `GH_TOKEN=invalid-token-for-test gh auth status` | Bad token. Exit 1. |
| `auth-bad-token-issue-view.txt` | `GH_TOKEN=invalid-token-for-test gh issue view 14622 -R cli/cli --json number` | HTTP 401. Exit 1. |
| `auth-bad-token-api.txt` | `GH_TOKEN=invalid-token-for-test gh api rate_limit --jq .rate.limit` | HTTP 401 JSON body. Exit 1. |
| `auth-unauth-status.txt` | `GH_CONFIG_DIR=<empty dir> gh auth status` | No hosts configured. Exit 1. |
| `auth-unauth-issue-view.txt` | `GH_CONFIG_DIR=<empty dir> gh issue view 14622 -R cli/cli --json number` | Auth needed, even for a public repo. Exit 4. |
| `auth-unauth-api-public.txt` | `GH_CONFIG_DIR=<empty dir> gh api repos/cli/cli/issues/14622 --jq .number` | Same. Exit 4. |
| `auth-unauth-graphql-viewer.txt` | `GH_CONFIG_DIR=<empty dir> gh api graphql -f query='{ viewer { login } }'` | Same. Exit 4. |
| `gh-help-exit-codes.txt` | `gh help exit-codes` | Exit codes 0, 1, 2, 4. |

## Type detection (issue or PR)

| File | Command | Notes |
| --- | --- | --- |
| `type-rest-issue.txt` | `gh api repos/cli/cli/issues/14622 --jq '{...has("pull_request")}'` | Issue: no `pull_request` key. |
| `type-rest-pr.txt` | `gh api repos/cli/cli/issues/14640 --jq '{...has("pull_request")}'` | PR: `pull_request` key present. |
| `type-rest-missing.txt` | `gh api repos/cli/cli/issues/999999999` | HTTP 404. Exit 1. |
| `type-wrong-type-cli.txt` | `gh issue view 14640 ...` and `gh pr view 14622 ...` | `issue view` accepts a PR number. `pr view` rejects an issue number. |
| `type-via-url-field.txt` | `gh issue view 14640 -R cli/cli --json url` and `... 14622 ...` | URL path reveals type: `/pull/` or `/issues/`. |
| `url-forms.txt` | `gh pr view <url>` and `gh issue view <url>` for `/files`, `/checks`, issue URL to `pr view`, PR URL to `issue view`, comment anchor, trailing slash, number form | See the file for each result. Includes the wrong-type URL cases. |

## Issue and PR fields

| File | Command | Notes |
| --- | --- | --- |
| `issue-view-14622.txt` | `gh issue view 14622 -R cli/cli --json number,title,state,stateReason,labels,issueType,author,closedAt,url` | Issue fields. |
| `issue-view-issuetype.txt` | `gh issue view 14622 -R cli/cli --json issueType` | `null`. |
| `issue-view-bad-field.txt` | `gh issue view 14622 -R cli/cli --json bogusField` | Unknown field error lists all valid fields. Exit 1. |
| `issue-view-on-pr-isdraft.txt` | `gh issue view 14640 -R cli/cli --json isDraft` | `isDraft` is not an issue field. Exit 1. |
| `json-fields-help.txt` | `gh issue view --help`, `gh pr view --help`, `gh pr checks --help` (JSON FIELDS sections) | Field lists. |
| `issue-type-samples.txt` | `gh issue list -R microsoft/vscode ...`, `gh issue list -R cli/cli ...` | `issueType` is `null` in these samples. |
| `issue-type-golang.txt` | `gh issue list -R golang/go ...` | `issueType` is `null` in these samples. |
| `pr-view-14640-open.txt` | `gh pr view 14640 -R cli/cli --json number,title,state,isDraft,reviewDecision,mergeStateStatus,headRefName,baseRefName,url,author,closedAt,mergedAt` | Open PR. |
| `pr-view-14633-merged.txt` | `gh pr view 14633 ... --json number,title,state,isDraft,reviewDecision,mergedAt,closedAt` | Merged PR. |
| `pr-view-14630-closed.txt` | same command for `14630` | Closed, not merged. |
| `pr-view-14640-rollup.txt` | `gh pr view 14640 -R cli/cli --json statusCheckRollup` | Trimmed to 4000 characters. |
| `graphql-enum-introspection.txt` | `gh api graphql -f query='{ __type(name:"...") { enumValues { name } } }'` for `StatusState`, `PullRequestReviewDecision`, `PullRequestState`, `IssueStateReason`, `IssueState`, `MergeStateStatus` | Enum values from the live schema. |

## PR checks and exit codes

| File | Command | Notes |
| --- | --- | --- |
| `pr-checks-14640-plain.txt` | `gh pr checks 14640 -R cli/cli` | Table. Exit 1 because `govulncheck` failed. |
| `pr-checks-14640-json-bucket.txt` | `gh pr checks 14640 -R cli/cli --json name,state,bucket` | Contains `{"bucket":"fail","name":"govulncheck","state":"FAILURE"}`. Exit 0. |
| `pr-checks-14640-json-jq-fail-count.txt` | `gh pr checks 14640 -R cli/cli --json bucket --jq 'map(select(.bucket=="fail")) \| length'` | Prints `1`. Exit 0. |
| `pr-checks-14640-json.txt` | `gh pr checks 14640 -R cli/cli --json name,state,bucket,workflow,link,event,startedAt,completedAt,description` | Check JSON, trimmed to 3000 chars. Exit 0. |

**Key observation (observed):** `gh pr checks` exits 1 for a failed check in plain output. With `--json` it exits 0, even when a check failed. Read the `bucket` field in JSON mode. Do not rely on the exit code. Exit 8 (pending) under `--json` was not tested.
| `pr-checks-json-fields.txt` | `gh pr checks --help` (JSON FIELDS) | Field list. |
| `pr-checks-help-head.txt` | `gh pr checks --help` (head) | Documents exit code 8 (checks pending). |
| `pr-list-open-sample.txt` | `gh pr list -R cli/cli --state open --limit 12 --json number,title` | Open PR list used for the pending search. |
| `pending-search.txt` | Loop over 12 open PRs: `gh pr checks N -R cli/cli` exit code and bucket counts | Exit 1 when any check fails. Exit 0 when only pass or skipping. No PR was pending at capture time, so exit 8 was not observed live. |
| `gh-help-environment.txt` | `gh help environment` | `GH_HOST`, `GH_REPO`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GH_CONFIG_DIR`, `GH_DEBUG`. |

## Batched GraphQL and timing

| File | Command | Notes |
| --- | --- | --- |
| `batch-query-sample.graphql` | (query text) | 3 aliases: issue 14622, PR 14640 (with `statusCheckRollup` state), PR 14633. |
| `batch-query-sample-output.json` | `gh api graphql -f query="$(cat batch-query-sample.graphql)"` | Data for all 3 items. Exit 0. |
| `batch-query-sample-stderr.txt` | same | Empty. |
| `batch-50-cost-probe.graphql` | (query text) | 50 aliases on `cli/cli` numbers 14600 to 14649, with a `rateLimit { cost remaining }` node. |
| `batch-50-cost-probe-output.json` | `gh api graphql -f query="$(cat batch-50-cost-probe.graphql)"` | `rateLimit.cost` = 1. 14 aliases are `null` (unknown numbers). |
| `batch-50-cost-probe-stderr.txt` | same | Per-alias "Could not resolve" errors. Exit 1 even though data came back. |
| `timing-runs.txt` | Five runs each of issue view, pr view, pr checks, REST issue, 3-alias batch, 50-alias batch | Wall time per call. Mean for issue view about 0.46 s. PR view about 0.7 s. PR checks about 1.1 s. REST issue about 0.47 s. 3-alias batch about 1.0 s. 50-alias batch about 1.3 s (exit 1, see stderr file). |
| `timing-issue-view-debug.txt` | `GH_DEBUG=api gh issue view 14622 ...` | One `POST /graphql` request. Query uses `issueOrPullRequest`. Token masked by gh. |

HTTP request counts (from `GH_DEBUG=api`, lines starting `* Request to`, observed): `gh issue view` = 1 GraphQL request. `gh pr view` = 1 GraphQL request (`pullRequest(number:)`). `gh pr checks` = 4 GraphQL requests (paging over check contexts). A per-item refresh of 50 items costs about 50 GraphQL points through `issue view`, about 200 through `pr checks`, and 1 point through the 50-alias batch (`rateLimit.cost` = 1, observed).

## Repo resolution and URLs

| File | Command | Notes |
| --- | --- | --- |
| `repo-resolution-project-dir.txt` | In `~/projects/claude-code-mod-tracking`: `git remote get-url origin`; `gh repo view --json nameWithOwner` | Origin exists (SSH). The owner is redacted to `<owner>`. The default repo resolves from the remote. |
| `repo-resolution-no-remote.txt` | In a scratch git repo with no remote: `git remote get-url origin`, `gh repo view`, `gh issue view 14622`, `GH_REPO=cli/cli gh issue view 14622`, `gh issue view cli/cli#14622`, full URL | `no git remotes found` for the number form. `owner/repo#N` is rejected. |
| `url-forms.txt` | See the table above | URL forms. |

## GitHub Enterprise (GHE)

| File | Command | Notes |
| --- | --- | --- |
| `ghe-host-probe.txt` | `GH_HOST=ghe.example.invalid gh issue view 1 -R o/r ...`; a URL on `ghe.example.invalid`; `gh auth status --hostname ghe.example.invalid` | Host not reachable: `error connecting`, exit 1. Host not logged in: exit 4 or exit 1. No real GHE host was tested. |

## Not found

| File | Command | Notes |
| --- | --- | --- |
| `not-found-repo-rest.txt` | `gh api repos/cli/nonexistent-repo-zz9 --jq .id` | HTTP 404. Exit 1. |
| `not-found-issue-number.txt` | `gh issue view 999999999 -R cli/cli` | `Could not resolve to an issue or pull request`. Exit 1. |
| `not-found-repo-issue-view.txt` | `gh issue view 1 -R cli/nonexistent-repo-zz9` | `Could not resolve to a Repository`. Exit 1. |
| `not-found-owner-issue-view.txt` | `gh issue view 1 -R nonexistent-owner-zz9/x` | Same. Exit 1. |

## Other

| File | Command | Notes |
| --- | --- | --- |
| `timing-runs.txt` | see above | Timing. |
