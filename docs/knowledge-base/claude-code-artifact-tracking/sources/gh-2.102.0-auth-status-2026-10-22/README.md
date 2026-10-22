# gh 2.102.0: `gh auth status --hostname <host>`

Live output from `gh` 2.102.0 (`/opt/homebrew/bin/gh`), captured 2026-10-22 on macOS (zsh). It is a new folder beside
[`../gh-2.102.0/`](../gh-2.102.0/README.md), whose snapshot stays as it was (the rule of this slug: never edit `sources/`,
add a new versioned folder). Added for issue #158: the check of a host that only a created PR names has to tell a
login that is missing or refused from a host that cannot be reached.

Read-only commands only. No login, logout, refresh or write to any GitHub object. Tag the claims from these files as
`observed`.

Each file is `$ command`, the merged stdout and stderr (`2>&1`), then `exit=N`. Redactions: the GitHub login is `<account>`,
and the config file of the fake-host and stored-token captures is `<config-dir>/hosts.yml`. Those captures use an own
`GH_CONFIG_DIR` in a temp dir, never the real one, with a dummy token (no `GH_*` variable set, no token printed) for
`ghe.example.invalid` (a reserved name that never resolves), for `192.0.2.1` (a TEST-NET address that is never routed) and
for github.com. With `--json hosts` the command exits 0 whatever the login state, prints the "not logged in" notice on
stderr and the JSON on stdout. An entry is `{state, error?, active, host, login, tokenSource, scopes?, gitProtocol}`, and
`state` is `success`, `error` or `timeout`.

Not captured: a timeout of a stored login on a real GHES host, a gh older than 2.81.0 (the flag `--json` came in 2.81.0), and
an env token on an unreachable host.

| File | Command | Notes |
| --- | --- | --- |
| `auth-status-host-logged-in.txt` | `gh auth status --hostname github.com` | Logged in. Exit 0. |
| `auth-status-host-logged-in-json.txt` | `... --json hosts` | `state: success`. Exit 0. |
| `auth-status-host-no-login.txt` | `gh auth status --hostname ghe.example.invalid` (logged in to github.com only) | `You are not logged into any accounts on <host>`. No `gh auth login` in it. Exit 1. |
| `auth-status-host-no-login-json.txt` | `... --json hosts` | The same notice, then `{"hosts":{}}`. Exit 0. |
| `auth-status-host-bad-token-json.txt` | `GH_TOKEN=invalid-token-for-test gh auth status --hostname github.com --json hosts` | Active entry `state: error`, `error` holds `non-200 OK status code: 401`. A second entry, the keyring account, is `success` and not active. Exit 0. |
| `auth-status-host-stored-bad-token-json.txt` | `GH_CONFIG_DIR=<dir> gh auth status --hostname github.com --json hosts` (a `hosts.yml` with a dummy stored token for github.com, no `GH_*` variable set) | A stored token that the host refuses: `state: error`, `error` is `HTTP 401: Bad credentials (https://api.github.com/)`, not the `non-200 OK status code: 401` of an env token. On a GHES host the URL is `https://<host>/api/v3/`. Exit 0. |
| `auth-status-host-stored-bad-token.txt` | `GH_CONFIG_DIR=<dir> gh auth status --hostname github.com` (the same config) | Text: `Failed to log in ... The token in ... is invalid ... To re-authenticate, run: gh auth login -h github.com`. Exit 1. A `gho_` dummy token would say `gh auth refresh -h` instead. |
| `auth-status-host-dns.txt` | `GH_CONFIG_DIR=<dir> gh auth status --hostname ghe.example.invalid` (stored dummy token, name does not resolve) | Text: `Failed to log in ... The token in ... is invalid ... To re-authenticate, run: gh auth login -h ...`. A DNS failure reads as an invalid token. Exit 1. |
| `auth-status-host-dns-json.txt` | `... --json hosts` | `state: error`, `error` holds `dial tcp: lookup ghe.example.invalid: no such host`. Exit 0. |
| `auth-status-host-timeout.txt` | `GH_CONFIG_DIR=<dir> gh auth status --hostname 192.0.2.1` (stored dummy token) | Text: `Timeout trying to log in to <host>`, no login hint. About 30 s. Exit 1. |
| `auth-status-host-timeout-json.txt` | `... --json hosts` | `state: timeout`, `error` holds `dial tcp 192.0.2.1:443: i/o timeout`. Exit 0. |
| `auth-status-unknown-flag.txt` | `gh auth status --hostname ghe.example.invalid --no-such-flag` | `unknown flag: ...` and the usage, exit 1. gh 2.102.0 has `--json`, so this stands in for the answer of an older gh to `--json hosts`. |
| `auth-status-help.txt` | `gh auth status --help` | Documents `--json hosts` and the exit 0 rule. |

