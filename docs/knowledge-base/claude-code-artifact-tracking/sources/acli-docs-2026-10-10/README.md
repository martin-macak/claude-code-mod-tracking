# Snapshots: Atlassian CLI public docs

Fetched 2026-10-10 with `curl` from `https://developer.atlassian.com/cloud/acli/`.

- `raw-html/changelog.html`: byte-verbatim HTML of `/changelog/`.
- `raw-html/install.html`: byte-verbatim HTML of `/guides/install-acli/`.
- `changelog-full-page.txt`: text extracted from `/changelog/` by a script (tags stripped). Not byte-verbatim.
- `guides-install-acli.txt`: same, from `/guides/install-acli/`.
- `jira-workitem-view.txt`: same, from `/reference/commands/jira-workitem-view/`.
- `jira-workitem-search.txt`: same, from `/reference/commands/jira-workitem-search/`.
- `reference-commands-jira-auth-login.txt`, `reference-commands-jira-auth-switch.txt`: same, from the matching reference pages.

Findings:

- The reference pages say "Last updated Oct 3, 2024". They match the `--help` output of 1.3.19.
- The changelog ends at `1.3.15-stable` (2026-03-25). That release needs site admins to re-authorize ACLI for each site (new OAuth scopes).
- Nothing public covers 1.3.16 to 1.3.39. A web search found no notes for 1.3.39. Context7 was not usable (authentication stub only). The 1.3.19 to 1.3.39 delta is an open question.
