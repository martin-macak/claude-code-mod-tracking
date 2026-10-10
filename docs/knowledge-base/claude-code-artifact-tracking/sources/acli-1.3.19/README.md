# Snapshots: acli 1.3.19-stable

Origin: the Atlassian CLI `acli`, version `1.3.19-stable` (`/opt/homebrew/bin/acli`).
Captured: 2026-10-10 on macOS, against one Jira Cloud site.
Auth: OAuth (`oauth_global`), one profile. The CLI said `1.3.39-stable` exists. It was not installed or upgraded.

Rules for these files:

- Never edit them. Refresh by adding a new versioned folder.
- All commands were read-only. No Jira object was created, changed or deleted. No login, logout or switch ran.
- Redacted: site name -> `<site>`, email -> `<email>`, display name, account IDs, avatar URLs, the Jira API host -> `<jira-host>`.
- Redacted: all `summary` values -> `<summary>`, all description text -> `<text>`.
- Redacted: real keys were replaced by synthetic keys (`PROJ-101`, `PROJ-200`..`PROJ-205`, `PROJ-300`..`PROJ-304`, `OTHER-5`). Shapes and types are real.
- Numeric `id` values and issue type / status names are real.
- `*.json.meta` hold the exit code and stderr of the command that made the `.json` file.
- `.txt` files in `01`..`18` hold `exit=`, then `--- stdout`, then `--- stderr`.

Real-to-synthetic key map (for reading the files only; keys are internal): task with 5 sub-tasks = `PROJ-200`; its sub-tasks = `PROJ-201..205`; epic = `PROJ-300`; epic children = `PROJ-301..304`, `OTHER-5` (another project); a bug = `PROJ-101`.

## Auth and version

| File | Command |
| --- | --- |
| `01-version.txt` | `acli --version` (the "outdated" nag goes to stdout) |
| `02-auth-status.txt` | `acli jira auth status` |
| `03-auth-status-unauthenticated.txt` | `HOME=<empty dir> acli jira auth status` (simulates no login) |
| `04-view-unauthenticated.txt` | `HOME=<empty dir> acli jira workitem view KEY --json` |
| `05-search-unauthenticated.txt` | `HOME=<empty dir> acli jira workitem search --jql "project = X" --json` |
| `08-auth-status-network-failure.txt` | `HTTPS_PROXY=http://127.0.0.1:9 acli jira auth status` |

## Errors

| File | Command |
| --- | --- |
| `06-view-network-failure.txt` | `HTTPS_PROXY=http://127.0.0.1:9 acli jira workitem view KEY --json` |
| `07-search-network-failure.txt` | `HTTPS_PROXY=http://127.0.0.1:9 acli jira workitem search --jql "project = X" --json` |
| `09-view-unknown-key.txt` | `acli jira workitem view ZZZZ-99999 --json` |
| `10-view-malformed-key.txt` | `acli jira workitem view foo --json` |
| `11-view-no-key.txt` | `acli jira workitem view --json` |
| `12-view-url-as-key.txt` | `acli jira workitem view "https://example.atlassian.net/browse/KEY" --json` |
| `13-search-bad-jql.txt` | `acli jira workitem search --jql "foo = = bar" --json` |
| `14-search-unknown-key-jql.txt` | `acli jira workitem search --jql "key = ZZZ-1" --json` |
| `15-search-field-not-allowed.txt` | `acli jira workitem search --jql "key = KEY" --fields parent,subtasks --json` |
| `16-search-empty-result.txt` | `acli jira workitem search --jql 'summary ~ "zzzqqqxxxnone"' --json` |
| `17-search-count.txt` | `acli jira workitem search --jql 'parent = EPIC' --count` |
| `18-view-devnull-stdout-quirk.txt` | `acli jira workitem view KEY --fields summary --json >/dev/null` |

## View (one work item)

| File | Command |
| --- | --- |
| `20-view-default.json` | `acli jira workitem view KEY --json` |
| `21-view-fields-...--task-with-5-subtasks.json` | `acli jira workitem view TASK --fields key,issuetype,status,summary,parent,subtasks --json` |
| `22-view-fields-parent-subtasks--subtask.json` | same command, on a Sub-task |
| `23-view-fields-parent-subtasks--epic.json` | same command, on an Epic |
| `24-view-fields-key-only--quirk-null.json` | `acli jira workitem view KEY --fields key --json` |
| `25-view-fields-summary-only.json` | `acli jira workitem view KEY --fields summary --json` |

## Search (JQL)

| File | Command |
| --- | --- |
| `30-search-default-limit3.json` | `acli jira workitem search --jql "assignee = currentUser() ORDER BY updated DESC" --limit 3 --json` |
| `31-search-children-of-epic--parent-eq.json` | `acli jira workitem search --jql "parent = EPIC" --fields issuetype,status,summary --json` |
| `32-search-children-of-task--parent-eq.json` | same, with `parent = TASK` |
| `33-search-children-batch--parent-in.json` | same, with `parent in (A,B,C)` (one call for several parents) |
| `34-search-fields-key-only--quirk-null-elements.json` | `... --fields key --json` |
| `35-search-limit-2-paginate-flag.json` | `... --limit 2 --paginate --json` |

## Other

| File | Content |
| --- | --- |
| `36-search-no-limit-default-page-size.txt` | Default page size without `--limit` (30, observed) and `--count` |
| `40-timing.txt` | Wall-clock timings of the calls above |
| `41-config-layout.txt` | Local config layout (keys only), env vars found in the binary |
| `help/*.txt` | Verbatim `--help` of root, `jira`, `jira workitem`, `view`, `search`, `jira auth`, `login`, `status`, `switch`, `auth`, `config` |

Public docs (fetched 2026-10-10) live in the sibling folder [`../acli-docs-2026-10-10/`](../acli-docs-2026-10-10/). The public changelog stops at 1.3.15-stable (2026-03-25). It says nothing about 1.3.16 to 1.3.39.
