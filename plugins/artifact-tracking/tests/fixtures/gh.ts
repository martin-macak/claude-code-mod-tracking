// Fixtures for gh-tool tests, copied from docs/knowledge-base/claude-code-artifact-tracking/sources/gh-2.102.0/.
// Each constant names its source file. JSON fixtures are trimmed but still parse.
// Exit codes come from the "exit=" line of the source file.

/** batch-query-sample-output.json (exit 0, 3 aliases a, b, c: closed issue, open PR with FAILURE rollup, merged PR). */
export const BATCH_SAMPLE_OUTPUT = "{\"data\":{\"a\":{\"issueOrPullRequest\":{\"__typename\":\"Issue\",\"number\":14622,\"title\":\"gh pr edit fails with 'GraphQL: Projects (classic) is being deprecated' on repos with classic projects\",\"state\":\"CLOSED\",\"stateReason\":\"DUPLICATE\",\"url\":\"https://github.com/cli/cli/issues/14622\"}},\"b\":{\"issueOrPullRequest\":{\"__typename\":\"PullRequest\",\"number\":14640,\"title\":\"`gh issue artifact` stack 11/12: Address review feedback\",\"state\":\"OPEN\",\"isDraft\":false,\"reviewDecision\":\"REVIEW_REQUIRED\",\"mergeStateStatus\":\"BLOCKED\",\"url\":\"https://github.com/cli/cli/pull/14640\",\"commits\":{\"nodes\":[{\"commit\":{\"statusCheckRollup\":{\"state\":\"FAILURE\"}}}]}}},\"c\":{\"issueOrPullRequest\":{\"__typename\":\"PullRequest\",\"number\":14633,\"title\":\"chore(deps): bump golang.org/x/sync from 0.23.0 to 0.24.0\",\"state\":\"MERGED\",\"mergedAt\":\"2026-10-09T14:14:41Z\",\"url\":\"https://github.com/cli/cli/pull/14633\"}}}}"

/** batch-50-cost-probe-output.json, trimmed to 3 aliases. i14600 is NOT_FOUND. Exit was 1. */
export const BATCH_50_PROBE_OUTPUT = "{\"data\":{\"rateLimit\":{\"cost\":1,\"remaining\":4777,\"limit\":5000,\"resetAt\":\"2026-10-10T11:14:04Z\"},\"i14600\":{\"issueOrPullRequest\":null},\"i14601\":{\"issueOrPullRequest\":{\"__typename\":\"Issue\",\"number\":14601,\"state\":\"CLOSED\",\"stateReason\":\"NOT_PLANNED\",\"title\":\"Re-show cursor on ctrl-c when requesting\"}},\"i14602\":{\"issueOrPullRequest\":{\"__typename\":\"PullRequest\",\"number\":14602,\"state\":\"CLOSED\",\"isDraft\":false,\"reviewDecision\":\"REVIEW_REQUIRED\",\"title\":\"Restore terminal cursor when interrupted while the spinner is running\"}}},\"errors\":[{\"type\":\"NOT_FOUND\",\"path\":[\"i14600\",\"issueOrPullRequest\"],\"locations\":[{\"line\":3,\"column\":51}],\"message\":\"Could not resolve to an issue or pull request with the number of 14600.\"}]}"

/** batch-50-cost-probe-stderr.txt, trimmed to the first 2 lines. */
export const BATCH_50_PROBE_STDERR = "gh: Could not resolve to an issue or pull request with the number of 14600.\nCould not resolve to an issue or pull request with the number of 14603.\n"

/** auth-unauth-issue-view.txt (no credentials). Exit 4, empty stdout. */
export const AUTH_UNAUTH_STDERR = "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n"

/** auth-bad-token-api.txt stdout (no GraphQL data key). Exit 1. */
export const AUTH_BAD_TOKEN_STDOUT = "{\n  \"message\": \"Bad credentials\",\n  \"documentation_url\": \"https://docs.github.com/rest\",\n  \"status\": \"401\"\n}"

/** auth-bad-token-api.txt stderr. Exit 1. */
export const AUTH_BAD_TOKEN_STDERR = "gh: Bad credentials (HTTP 401)\n"

/** ghe-host-probe.txt, first command (unreachable host). Exit 1. */
export const GHE_HOST_PROBE_STDERR = "error connecting to ghe.example.invalid\ncheck your internet connection or https://githubstatus.com\n"

/** ghe-host-probe.txt, `gh auth status --hostname ghe.example.invalid`. Exit 1. */
export const GHE_AUTH_STATUS_STDERR = "You are not logged into any GitHub hosts. To log in, run: gh auth login\n"

/** repo-resolution-project-dir.txt, `gh repo view --json nameWithOwner`. Exit 0. Has no url field. */
export const REPO_RESOLUTION_STDOUT = "{\"nameWithOwner\":\"<owner>/claude-code-mod-tracking\"}"

