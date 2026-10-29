# Spikes, 2026-10-26: the config problem log burst

Scripts and tables of the probe behind the block "Cost of the config problem burst" in [limits-and-diagnostics](../../../reference/limits-and-diagnostics.md#cost-of-the-config-problem-burst-issue-219). It ran for the design study of [issue #219](https://github.com/martin-macak/claude-code-mod-tracking/issues/219) on Claude Code **2.1.310** (the types snapshot is 2.1.302), macOS (Apple M5 Pro, 18 cores), on 2026-10-26. It answers one question: what does the real engine pay for the burst of one `$.ui.log` call per bad config key at `session.start`?

This folder is evidence, not product. It is a snapshot: do not edit it.

## What is here

| Path | What it is |
| --- | --- |
| `fake-api.mjs` | The fake Messages API, copied unchanged from [`live-probe-2026-10-10/repro/fake2.mjs`](../../../../claude-code-auto-tracking/sources/live-probe-2026-10-10/repro/fake2.mjs). It plays the turns of `seq.json`. |
| `seq.json` | One text turn: `{"main":[[{"type":"text","text":"done"}]]}`. |
| `run.sh <keys> <tag>` | One headless `claude -p` run of the real mod with `<keys>` unknown keys in `global`. |
| `tui.sh <keys> <tag>` | One interactive session in a private tmux server (`-L p219`), same config. |
| `runlp.sh <keys> <batch> <tag>` | One headless run of the isolated `logprobe/` plugin: `<keys>` lines, `<batch>` lines per `$.ui.log` call. |
| `logprobe/` | The isolated plugin of the batching probe. `claude plugin validate` passed. |
| `extract.mjs` | Reads the engine line `session.start settled in`, counts the problem lines and measures the span of the burst. |
| `evidence.md` | The tables of the study: time by size, the last problem line against the settle line, debug file rotation, batching. |
| `excerpts/debug-entries.txt` | The debug entries of one call, and the settle line, with the timestamps as the engine wrote them. The label lines and each `[...]` (a cut) are ours. |

`<SCRATCH>` stands for the scratch folder of the run. It holds `probe/` (the fake API, `seq.json`, `logprobe/`), `work/` (a fresh `git init` folder, the cwd of every run) and `runs/`. `<REPO>` stands for the checkout. Set both before you run a script.

The raw debug logs and the per-run CPU rows stayed in the scratch folder of the study and are not kept. `evidence.md` holds the numbers that the study listed, and the gaps of the last problem line, which the review of the pull request computed again from those logs.

## How a run went

1. `PORT=8821 SEQ=<SCRATCH>/probe/seq.json node fake-api.mjs`.
2. `run.sh <keys> <tag>`. Each run has its own `CLAUDE_CONFIG_DIR`, `CLAUDE_TRACKER_CONFIG_DIR`, `HOME` and `GH_CONFIG_DIR` in `<SCRATCH>/runs/<tag>/`. `--tools ''` and `--strict-mcp-config` keep the model from running anything. `--debug-file` gives the log. `DBGMODE=default` uses `--debug` and copies `debug/latest`. Process CPU comes from `/usr/bin/time -l` (`time.txt` of each run).
3. `tui.sh <keys> <tag>` seeds `.claude.json` with `hasCompletedOnboarding`, `theme` and `projects.<cwd>.hasTrustDialogAccepted`. It waits for the settle line, waits 4 s, saves the pane, sends `/exit` and kills the tmux server.
4. `node extract.mjs <runs>/*/debug.log`. For the batching probe, read the line `logprobe@inline session.start settled in` and the probe line `probe: loop done`. The drain time is the time from the settle line to that line.

The config file holds `{"version":1,"global":{"k0":0,...}}`: the same shape as `unknownKeys()` in `plugins/artifact-tracking/tests/problems-cap.test.ts`. The mod writes its defaults back, so the file grows (820 KB at 40000 keys).

Series: sizes alternate in each round, so a load spike hits both. Rounds 1 to 3 ran 0, 2500, 5000 and 10000 keys. Rounds 4 to 21 alternated 0 and 5000 keys. Two rounds ran 20000 and 40000 keys. Single runs ran 25000, 30000 and 35000 keys. One smoke run each ran 0 and 5000 keys. One run each ran 5000 and 40000 keys with `DBGMODE=default`. The interactive series ran 0 keys (twice), 5000 keys (three times) and 10000 keys. The batching series ran `runlp.sh 5000 <B> <tag>` three times for each B in 1, 50, 500. About 75 runs in all.

## Grade

| Run type | Grade | Why |
| --- | --- | --- |
| Interactive tmux, fake API behind it | *verified-live* | The KB defines it as an interactive session. The model plays no part in `session.start`. Same grade as [spikes-2026-10-21](../../spikes-2026-10-21/README.md#runs). Owner decision of 2026-10-26. |
| Headless `claude -p`, fake API behind it | *verified-kit* | A headless run counts as *verified-kit*, never as live. It carries the statistical weight (22 runs). |
| Isolated `logprobe` | *verified-kit* | Headless. |

Every number is observed on a managed machine under load (see `evidence.md`). No session ran under the owner's login, and no run touched real GitHub data.
