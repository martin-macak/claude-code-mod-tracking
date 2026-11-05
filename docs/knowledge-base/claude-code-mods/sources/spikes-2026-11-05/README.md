# Spikes 2026-11-05

Captured on 2026-11-05 for [issue #91](https://github.com/martin-macak/claude-code-mod-tracking/issues/91). Not a primary source: it is the evidence behind the section "Live run without the guard" of [lifecycle-manager §5.7](../../../claude-code-mod-architecture/lifecycle-manager.md#57-context-injection) and behind [open-questions Q33](../../../claude-code-mod-architecture/open-questions.md).

## `prompt-section-live/`

One run of the prompt-section runbook of issue #91 on a GitHub Actions runner. The runner has no managed settings and a personal OAuth sign-in, so the built-in guard `cc-plugin-sec-default` did not load.

| Fact | Value |
| --- | --- |
| Run | [actions/runs/41999247206](https://github.com/martin-macak/claude-code-mod-tracking/actions/runs/41999247206), workflow `prompt-section-live`, job `live` (13 min) |
| Mod and script | commit `fc8b826a1aa12c3db166212bc32d74a681cbb352`: `plugins/artifact-tracking/`, `.github/workflows/prompt-section-live.yml`, `scripts/live/prompt-section-run.sh` |
| Host | `ubuntu-latest`, Linux 7.0.0-1019-azure |
| Claude Code | 2.1.302 (pinned by the workflow), model `claude-haiku-5-5` (`haiku`) |
| Sign-in | `CLAUDE_CODE_OAUTH_TOKEN`. `apiKeySource` is `none`. No API key was used |
| Mode | headless `claude -p` against the real API, `stream-json` input and output. No interactive session |
| Arms | A (section off, snapshot on), B (on, on), C (on, snapshot off), D (off, off): six messages 12 s apart. B and C also ran the compact plan: 11 messages, with `/compact` as message 6 and a 60 s wait after it |

The files come from the run artifact `prompt-section-live-logs`. The run's own script redacted the artifact before it was uploaded (keys, home paths, user names in paths, email addresses, the lists of tools, skills and agents in the init messages, and every debug line that does not match the mod, the engine's prompt or the compaction). The four verbatim files below are copies of files of that redacted artifact. They are not the raw logs.

| File | What it is |
| --- | --- |
| `summary.txt` | The run's own report, verbatim: environment, managed-settings check, guard check, the token table, the per-run tables, the mod's debug lines, the `prompt.compose` runs per window and the compaction metadata. It ends with the part that did not run. |
| `guard-check.extract.txt` | Verbatim copy of the debug extract of the guard check (one request, "Reply with OK."). Line 6 reads `cc-plugin-sec-default@builtin not seated: no managed settings and not a Team or Enterprise organization (none)`. |
| `B-compact.debug.extract.txt`, `C-compact.debug.extract.txt` | Verbatim copies of the debug extracts of B-compact and C-compact. They show the `prompt.compose` run right before the compaction request (`source=compact`), the `reactive-compact ... finished` line with the usage of the compaction, the `section rebuilt` lines (1, 2 and 3 lines) and the 60 s gap. |
| `turns.tsv` | Derived, not verbatim. One row for the guard check and one row per message of the six runs, with the requests, the input, `create`, `create_1h` (the part of `create` written as a 1-hour entry) and `read` tokens, their sum, the output and thinking tokens, the cumulative `total_cost_usd`, the message and the full answer. |

To redo `turns.tsv` from the run artifact, take one `<run>.jsonl` (the guard check has `guard-check.jsonl` and no `marks.tsv`):

```bash
jq -r 'select(.type=="result") | [.result_index+1, .num_turns, .usage.input_tokens,
  .usage.cache_creation_input_tokens, .usage.cache_creation.ephemeral_1h_input_tokens,
  .usage.cache_read_input_tokens,
  (.usage.input_tokens + .usage.cache_creation_input_tokens + .usage.cache_read_input_tokens),
  .usage.output_tokens, .usage.output_tokens_details.thinking_tokens, .total_cost_usd,
  (.result | gsub("[\\s]+"; " ") | gsub("^ | $"; ""))] | @tsv' A-six.jsonl
```

The message text is column 4 of the `marks.tsv` of the run. The `/compact` message of a compact run (message 6) has zero usage in its result, so its row is zero. The compaction is metered all the same: `total_cost_usd` steps up, and the `reactive-compact` line of the debug extract holds its usage.

Left out on purpose: the other 30 files of the run artifact (the raw streams, the other debug extracts, the config files and the `marks.tsv` files). The streams hold 25 to 77 KB each, and the numbers that the pages quote are in `summary.txt` and `turns.tsv`. GitHub keeps the artifact for 30 days. The thinking text of the streams is empty (`thinking` is a zero-length string with a signature), so only the thinking token counts are kept.

The files hold no email, no home path and no token. The runner user is `runner`. A search for `@` followed by a domain, `/Users/`, `/home/`, `sk-ant`, `ghp_`, `Bearer` and `eyJ` found nothing. Paths in the debug lines start with `~`.

Not run: the `trackers.processes.endedTtlMs` addendum of the second comment on the issue. It needs the `/track` pane and a background Bash task. The pane exists only in the interactive TUI, and `claude -p` has none. [Issue #389](https://github.com/martin-macak/claude-code-mod-tracking/issues/389) tracks it.

Do not edit it. To add more evidence, make a new dated folder.
