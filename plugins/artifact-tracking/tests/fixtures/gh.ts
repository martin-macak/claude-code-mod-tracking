// Fixtures for gh-tool tests, copied from docs/knowledge-base/claude-code-artifact-tracking/sources/gh-2.102.0/.
// Each constant names its source file. JSON fixtures are trimmed but still parse.
// Exit codes come from the "exit=" line of the source file.

/** batch-query-sample-output.json (exit 0, 3 aliases a, b, c: closed issue, open PR with FAILURE rollup, merged PR). */
export const BATCH_SAMPLE_OUTPUT =
  '{"data":{"a":{"issueOrPullRequest":{"__typename":"Issue","number":14622,"title":"gh pr edit fails with \'GraphQL: Projects (classic) is being deprecated\' on repos with classic projects","state":"CLOSED","stateReason":"DUPLICATE","url":"https://github.com/cli/cli/issues/14622"}},"b":{"issueOrPullRequest":{"__typename":"PullRequest","number":14640,"title":"`gh issue artifact` stack 11/12: Address review feedback","state":"OPEN","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED","url":"https://github.com/cli/cli/pull/14640","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE"}}}]}}},"c":{"issueOrPullRequest":{"__typename":"PullRequest","number":14633,"title":"chore(deps): bump golang.org/x/sync from 0.23.0 to 0.24.0","state":"MERGED","mergedAt":"2026-10-09T14:14:41Z","url":"https://github.com/cli/cli/pull/14633"}}}}'

/** batch-50-cost-probe-output.json, trimmed to 3 aliases. i14600 is NOT_FOUND. Exit was 1. */
export const BATCH_50_PROBE_OUTPUT =
  '{"data":{"rateLimit":{"cost":1,"remaining":4777,"limit":5000,"resetAt":"2026-10-10T11:14:04Z"},"i14600":{"issueOrPullRequest":null},"i14601":{"issueOrPullRequest":{"__typename":"Issue","number":14601,"state":"CLOSED","stateReason":"NOT_PLANNED","title":"Re-show cursor on ctrl-c when requesting"}},"i14602":{"issueOrPullRequest":{"__typename":"PullRequest","number":14602,"state":"CLOSED","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","title":"Restore terminal cursor when interrupted while the spinner is running"}}},"errors":[{"type":"NOT_FOUND","path":["i14600","issueOrPullRequest"],"locations":[{"line":3,"column":51}],"message":"Could not resolve to an issue or pull request with the number of 14600."}]}'

/** batch-50-cost-probe-stderr.txt, trimmed to the first 2 lines. */
export const BATCH_50_PROBE_STDERR =
  'gh: Could not resolve to an issue or pull request with the number of 14600.\nCould not resolve to an issue or pull request with the number of 14603.\n'

/** auth-unauth-issue-view.txt (no credentials). Exit 4, empty stdout. */
export const AUTH_UNAUTH_STDERR =
  'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n'

/** auth-bad-token-api.txt stdout (no GraphQL data key). Exit 1. */
export const AUTH_BAD_TOKEN_STDOUT =
  '{\n  "message": "Bad credentials",\n  "documentation_url": "https://docs.github.com/rest",\n  "status": "401"\n}'

/** auth-bad-token-api.txt stderr. Exit 1. */
export const AUTH_BAD_TOKEN_STDERR = 'gh: Bad credentials (HTTP 401)\n'

/** ghe-host-probe.txt, first command (unreachable host). Exit 1. */
export const GHE_HOST_PROBE_STDERR =
  'error connecting to ghe.example.invalid\ncheck your internet connection or https://githubstatus.com\n'

/** ghe-host-probe.txt, `gh auth status --hostname ghe.example.invalid`. Exit 1. */
export const GHE_AUTH_STATUS_STDERR = 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n'

// `gh auth status --hostname <host>`, gh 2.102.0 (captured 2026-10-22, issue #158), copied from
// docs/knowledge-base/claude-code-artifact-tracking/sources/gh-2.102.0-auth-status-2026-10-22/. With `--json hosts` it exits 0 whatever
// the login state, and prints the "not logged in" notice on stderr. An entry is {state, error?, active, host, login, ...}.

/** auth-status-host-logged-in-json.txt, stdout. Exit 0. */
export const AUTH_STATUS_JSON_LOGGED_IN =
  '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"<account>","tokenSource":"keyring","scopes":"gist, project, read:org, repo, workflow","gitProtocol":"ssh"}]}}'

/** auth-status-host-no-login-json.txt, stdout (logged in to other hosts, not to this one). Exit 0. */
export const AUTH_STATUS_JSON_NO_LOGIN = '{"hosts":{}}'

/** auth-status-host-no-login-json.txt, stderr. The same line is the whole output of the text form (exit 1). */
export const AUTH_STATUS_NO_LOGIN_NOTICE = 'You are not logged into any accounts on ghe.example.invalid\n'

/** auth-status-host-bad-token-json.txt, stdout. The active entry is the bad token (HTTP 401), the second one is not active. Exit 0. */
export const AUTH_STATUS_JSON_BAD_TOKEN =
  '{"hosts":{"github.com":[{"state":"error","error":"non-200 OK status code: 401 Unauthorized body: \\"{\\\\r\\\\n  \\\\\\"message\\\\\\": \\\\\\"Bad credentials\\\\\\",\\\\r\\\\n  \\\\\\"documentation_url\\\\\\": \\\\\\"https://docs.github.com/rest\\\\\\",\\\\r\\\\n  \\\\\\"status\\\\\\": \\\\\\"401\\\\\\"\\\\r\\\\n}\\"","active":true,"host":"github.com","login":"","tokenSource":"GH_TOKEN","gitProtocol":"ssh"},{"state":"success","active":false,"host":"github.com","login":"<account>","tokenSource":"keyring","scopes":"gist, project, read:org, repo, workflow","gitProtocol":"ssh"}]}}'

/** auth-status-host-stored-bad-token-json.txt, stdout. A stored token (hosts.yml, as the keyring) that the host refuses: `HTTP 401: ...`, not the `non-200 OK` of an env token. Exit 0. */
export const AUTH_STATUS_JSON_STORED_BAD_TOKEN =
  '{"hosts":{"github.com":[{"state":"error","error":"HTTP 401: Bad credentials (https://api.github.com/)","active":true,"host":"github.com","login":"someone","tokenSource":"<config-dir>/hosts.yml","gitProtocol":"https"}]}}'

/** auth-status-host-dns-json.txt, stdout (a stored login, the name does not resolve). Exit 0. */
export const AUTH_STATUS_JSON_DNS =
  '{"hosts":{"ghe.example.invalid":[{"state":"error","error":"Get \\"https://ghe.example.invalid/api/v3/\\": dial tcp: lookup ghe.example.invalid: no such host","active":true,"host":"ghe.example.invalid","login":"someone","tokenSource":"<config-dir>/hosts.yml","gitProtocol":"https"}]}}'

/** auth-status-host-timeout-json.txt, stdout (a stored login, no answer). Exit 0. */
export const AUTH_STATUS_JSON_TIMEOUT =
  '{"hosts":{"192.0.2.1":[{"state":"timeout","error":"Get \\"https://192.0.2.1/api/v3/\\": dial tcp 192.0.2.1:443: i/o timeout","active":true,"host":"192.0.2.1","login":"someone","tokenSource":"<config-dir>/hosts.yml","gitProtocol":"https"}]}}'

/** auth-status-host-dns.txt, the text form of the same DNS failure: it reads as an invalid token. Exit 1. */
export const AUTH_STATUS_TEXT_DNS =
  'ghe.example.invalid\n  X Failed to log in to ghe.example.invalid account someone (<config-dir>/hosts.yml)\n  - Active account: true\n  - The token in <config-dir>/hosts.yml is invalid.\n  - To re-authenticate, run: gh auth login -h ghe.example.invalid\n  - To forget about this account, run: gh auth logout -h ghe.example.invalid -u someone\n'

/** auth-status-host-timeout.txt, the text form of a timeout: no login hint. Exit 1. */
export const AUTH_STATUS_TEXT_TIMEOUT =
  '192.0.2.1\n  X Timeout trying to log in to 192.0.2.1 account someone (<config-dir>/hosts.yml)\n  - Active account: true\n'

/** auth-status-unknown-flag.txt, first line: what an older gh says to `--json` (the capture names `--no-such-flag`). Exit 1. */
export const AUTH_STATUS_UNKNOWN_JSON_FLAG = 'unknown flag: --json\n'

/** The stdout of `gh auth status --hostname <host> --json hosts` for one account of `host`, in the shape of the captures. */
export const authStatusJson = (host: string, entry: { state: string; error?: string } = { state: 'success' }): string =>
  JSON.stringify({
    hosts: {
      [host]: [{ ...entry, active: true, host, login: '<account>', tokenSource: 'keyring', gitProtocol: 'ssh' }],
    },
  })

/** repo-resolution-project-dir.txt, `gh repo view --json nameWithOwner`. Exit 0. Has no url field. */
export const REPO_RESOLUTION_STDOUT = '{"nameWithOwner":"<owner>/claude-code-mod-tracking"}'
