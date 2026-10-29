# Evidence: the cost of the config problem log burst

Copied from the evidence comment of the design study of [issue #219](https://github.com/martin-macak/claude-code-mod-tracking/issues/219#issuecomment-6417825483). Claude Code 2.1.310, macOS (Apple M5 Pro, 18 cores), load average 18 to 60 (the one-minute value at the start of each run). The managed guard `cc-plugin-sec-default` is seated outermost, so **every number is observed on a managed machine**. The fake Messages API plays one text turn (no model, no login). The real mod of `main` (8c77e102) loaded unchanged. The metric is the engine's own line `hooks module artifact-tracking@inline session.start settled in <ms> (worker hop, next() included)`.

The raw debug logs, the per-run CPU rows and the request logs stayed in the scratch folder of the study. Only the tables below are kept. A median or a sum below is the study's arithmetic over those rows. The table of the last problem line against the settle line was computed again from those logs with `extract.mjs`, in the review of the pull request that adds this folder.

## Time of `session.start` by number of unknown keys

Headless runs alternate sizes, so a load spike hits both sizes. "First to last problem line" is the span of the problem entries in the debug file. For 30000 keys and more it counts the newest file only (see the rotation table).

| Keys | Mode | Runs | Settled, median (min to max), ms | Extra over 0 keys, ms | First to last problem line, median, ms | Process CPU, median, s |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | headless | 22 | 39 (31 to 477) | 0 | 0 | 1.54 |
| 2500 | headless | 3 | 168 (158 to 220) | 129 | 113 | 1.77 |
| 5000 | headless | 22 | 263 (233 to 5087) | 224 | 194 | 2.08 |
| 10000 | headless | 3 | 696 (549 to 1639) | 656 | 603 | 2.63 |
| 20000 | headless | 2 | 1733 (859 to 2606) | 1693 | 1553 | 3.46 |
| 25000 | headless | 1 | 1081 | 1041 | 975 | 4.01 |
| 30000 | headless | 1 | 1146 | 1107 | n/a | 4.05 |
| 35000 | headless | 1 | 1981 | 1942 | n/a | 4.63 |
| 40000 | headless, `--debug-file` | 2 | 4220 (3169 to 5271) | 4181 | n/a | 4.95 |
| 40000 | headless, `--debug` (default place) | 1 | 1603 | 1564 | n/a | 4.70 |
| 0 | interactive tmux | 2 | 294 (151 to 437) | n/a | 0 | n/a |
| 5000 | interactive tmux | 3 | 366 (275 to 687) | n/a | 287 | n/a |
| 10000 | interactive tmux | 1 | 681 | n/a | 573 | n/a |

The 22 headless runs at 5000 keys, sorted (ms): 233, 233, 234, 234, 234, 239, 241, 243, 245, 251, 261, 265, 267, 269, 279, 284, 321, 413, 895, 1124, 1773, 5087. The 22 runs at 0 keys: 31 to 47 ms for 18 runs, then 78, 106, 142, 477. One more run at 5000 keys with `--debug` (the default file) settled in 329 ms and kept 5000 problem lines.

CPU cost per key (process CPU minus the 0-key median, divided by the keys): 0.092 (2500), 0.108 (5000), 0.109 (10000), 0.096 (20000), 0.099 (25000), 0.084 (30000), 0.088 (35000), 0.085 (40000) ms. The CPU cost is flat, so the work is linear. Wall time at 10000 keys and more has 3 runs or fewer per size and is noisy. The fastest run of each size, minus the 0-key median (39 ms), per key: 48 (2500), 39 (5000), 51 (10000), 41 (20000), 42 (25000), 37 (30000), 55 (35000), 39 (40000) microseconds. This is a derived number and it is flat.

The kit, for comparison (scratch copy, load 48 to 55, `performance.now()` around `$.session.start`, 3 runs): 1250 keys 639, 669, 699 ms; 2500 keys 1451, 1427, 1385 ms; 5000 keys 4510, 4079, 4447 ms.

## The last problem line against the settle line, at 5000 keys

The gap is the time of the settle line minus the time of the last problem line in the debug file (`last to settle` in `extract.mjs`). A positive gap means the last problem line came first. Every run of the mod has a positive gap, and the file held 5000 of 5000 problem lines in every run. The isolated probe is the other way round (see the batching table below): its hook does nothing after the loop, so it settles first.

| Runs | Problem lines in the file | Gap, ms |
| --- | --- | --- |
| 20 of the 22 headless runs | 5000 in each | 24, 26, 26, 27, 27, 28, 29, 29, 29, 30, 36, 39, 40, 41, 41, 42, 42, 43, 99, 105 |
| 1 headless run (settled in 1773 ms) | 5000 | 712 |
| 1 headless run (settled in 5087 ms) | 5000 | 4190 |
| 3 interactive tmux runs (settled in 275, 366 and 687 ms) | 5000 in each | 40, 57, 84 |
| 1 headless run with `--debug` (the default place, settled in 329 ms) | 5000 | 49 |

The two slow gaps belong to the two slowest settles of the 22 runs. The 22 runs are the 21 runs of the alternating series and one smoke run.

## The debug file rotates at about 10 MiB

Problem lines in each file after one run (`--debug-file`, except the last row):

| Keys | Newest file | Older part (`<file>.1`) |
| --- | --- | --- |
| 20000 | 20000 lines, 7.99 MB | none |
| 25000 | 25000 lines, 9.97 MB | none |
| 30000 | 3571 lines (k26429 to k29999), 1.43 MB | not read (same split as 40000) |
| 35000 | 8571 lines (k26429 to k34999), 3.42 MB | not read |
| 40000 (2 runs) | 13571 lines (k26429 to k39999), 5.40 MB | 26429 lines (k0 to k26428), 10.52 MB, read in 1 run |
| 40000, `--debug` (default place) | `<session>.txt`: 13571 lines, 5.40 MB | `<session>.1.txt`: 26429 lines, 10.52 MB; `debug/latest` links to `<session>.txt` |

Each problem is 3 entries on this machine: 396 bytes (slope of the file size from 5000 to 10000 keys). The mod line alone is 142 bytes.

## Batching probe (isolated plugin, not the mod)

The probe plugin `logprobe/` sends 5000 problem-like lines to the debug log in its own `session.start`, B lines per `$.ui.log` call. Three runs per size. "Last line after settle" is the time from the settle line to the last probe line.

| B | Entries | Problem texts in the file | File size | Loop in the worker, ms | Settled, ms | Last line after settle, ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5000 | 5000 | 1.93 MB | 23 to 28 | 65, 80, 118 | 141 to 148 |
| 50 | 100 | 5000 | 0.42 MB | 2 | 23, 27, 35 | none (the last line came first) |
| 500 | 10 | 1497 | 0.16 MB | 0 to 1 | 8, 9, 10 | none |

A batch of 500 lines is about 36,000 characters. The engine cut each entry to 10,000 characters, so 70 percent of the texts are gone. A batch of 50 is about 3,700 characters. A multi-line text is one entry with the newlines escaped as `\n`.

## Other checks

- Budget lines: a search of all 75 debug logs for `overran`, `lingering` and `budget` found none.
- Cleanup: no `claude` process of the probe remained (a process list filtered by the scratch folder); the private tmux socket was killed; the fake API was stopped.
- Not kept: request logs and `append.attachment` rows (they hold the system prompt).
