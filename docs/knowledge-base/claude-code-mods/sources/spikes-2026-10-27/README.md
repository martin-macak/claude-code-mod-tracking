# Spikes, 2026-10-27

Source files and the evidence log of the probe behind the section [Keeping `/track qa` from the model](../../concepts/questions-and-plans.md#keeping-track-qa-from-the-model). It ran for [issue #246](https://github.com/martin-macak/claude-code-mod-tracking/issues/246), the follow-up of the spike #196, on Claude Code **2.1.311**, macOS, on 2026-10-27, against a fake Messages API (no model, no login). It re-ran what a verdict depends on: the rewrite and the request on the installed version, the line break after the plugin prefix, `claude -p`, and what the kit shows.

This folder is evidence, not product. It is a snapshot: do not edit it. The first version of the evidence is the second comment of the issue.

## What is here

| Path | What it is |
| --- | --- |
| `p246-probe/probe/hooks/register.ts` | The probe mod `p246-probe`: three commands and one `ui.render` hook on `CommandOutput`. `.claude-plugin/plugin.json` and `hooks/hooks.json` are the two small files that the issue did not post, written again for this folder. |
| `p246-probe/probe/tests/surfaces.test.ts` | The kit probe (K0, K0b, K1, K3): what `$.session.surfaces()` reads in a kit test, and what a `CommandOutput` rewrite looks like beneath the plugin. Run it with `claude plugin test .` in `p246-probe/probe`. |
| `p246-probe/fake/fake246.mjs` | The fake Messages API. It logs, per request, the probe markers and the `<local-command-stdout>` blocks that the `messages` hold. |
| `p246-probe/run.sh` | The launcher. The tmux driver and the config file follow the "How to run it again" steps of the [spikes-2026-10-26](../spikes-2026-10-26/README.md) folder, with the binary `2.1.311`. |
| `p246-probe/evidence-log.txt` | The runs E0 to E9 and the kit runs K0 to K3, as the study cites them. |
| `p246-probe/headless-real-mod.log` | The real mod under `claude -p --continue` on 2.1.312, with a Q&A call read back from the transcript. `/track qa`, `/track qa 1` and `/track qa --send` each print the whole text. Made by the PR of the build. |

The commands of the probe:

| Command | Reply (`command.run`) | Render hook |
| --- | --- | --- |
| `/p246b` | the Markdown title and one call, no leading line break (what `/track qa` answered before) | none |
| `/p246a` | the same text with one leading line break | none |
| `/p246c` | one leading line break, then a `## Q3` heading (the reply of `/track qa 3`) | none |
| `/p246s` | a stub (`STUB246: ...`) | rewrites `text` to the Markdown (`S-REWRITE`) |

## What it showed

| Question | Answer | Grade |
| --- | --- | --- |
| Does a line break after the plugin prefix draw the title as a heading? | Yes. Without it the row draws `p246-probe: # Questions and answers ...` with a literal `#`. With one leading line break the `#` is gone. `##` behaves the same. Main screen and fullscreen. | *verified-live* (2.1.311, E2 to E5) |
| Does the rewrite still draw, and do the stored row and the next request hold only the stub? | Yes. The request holds the stub and no `S-REWRITE`. | *verified-live* (E6, E7) |
| What does `claude -p` print for a reply with a leading line break? | `<plugin>: `, a line break, then the Markdown source. No render. | *verified-kit* (E8, E9) |
| What does the real mod print under `claude -p` when a Q&A call exists? | The whole text, with the line break after `artifact-tracking:` and the Markdown source after it, for `/track qa`, `/track qa 1` and `/track qa --send`. The call came back from the transcript. | *verified-kit* (2.1.312, `headless-real-mod.log`) |
| What does the hook's `$.session.surfaces()` read in a kit test? | It rejects with `no implementation for session.surfaces` unless the test answers that event. The surface of `$.session.start` does not feed it. | *verified-kit* (K0, K0b, K1) |
| Can a kit test check the rewrite of a `CommandOutput` row? | Yes: `$.ui.mount({ component: 'CommandOutput', ... })` with an `on('ui.render')` beneath shows the props that `next` received. | *verified-kit* (K3) |
| Does the guard stand in the way? | No: the guard lists neither `ui.render` nor `command.run` (E0). | *verified-live*, on a machine with managed settings |

The real mod ran the same way later, on Claude Code 2.1.312: `e2e/features/questions.feature` ("A question and my answer are listed by /track qa, word for word" and "/track qa --send gives the model the whole text") reads the command replies that the fake API of the e2e harness sees.
