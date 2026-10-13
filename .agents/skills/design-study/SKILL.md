---
name: design-study
description: Use when a user asks for a feasibility study, spike, research, gap analysis, proof of concept, design draft or go/no-go call for an issue or feature in this repo, or asks "can we build this", "how feasible is it" or "rank the feasibility".
---

# Design study

Turn an issue into a design that another agent can build with confidence. The output is a scored feasibility matrix, a design, and the evidence behind both.

**Core rule:** a verdict is only as strong as its evidence. Reading code or the types file gives a candidate answer. A spike that decides a verdict needs an observed run, or the item stays `Untested`.

## Steps

Do them in order. Go back when a later step changes an earlier answer.

1. **Frame.** Read the issue and its comments. Split it into requirement items `R1..Rn`: one per acceptance criterion or use case. Give each a priority: `Must`, `Should`, `Could`. Ask the user (`AskUserQuestion`) about unclear scope before you research.
2. **Research.** ProjectAtlas (`atlas_*`) to find files; `grep` when you already know the paths. Then the KB (`docs/knowledge-base/`), the specs (`docs/superpowers/specs/`), the types file (the authority), then the code. Use Context7 for external tools. Tag every claim: `[observed]`, `[primary source]`, `[public docs]`, `[inference]`. Never read the user's saved session transcripts (`~/.claude*/projects/`) or other sessions' data as evidence unless the user says yes to it first.
3. **Feasibility study.** Per item: mechanism, caveat, evidence. List the spike questions `S1..Sn` whose answers decide a verdict. Give a first score (see Scoring).
4. **PoC.** Answer every deciding spike with a run. Use the fake-API probe harness: it needs no model and no login. See `probing.md`. Save the probe, the scripts and the logs. Clean up all you started. If the tool under study is disabled under the fake API (tools that need a claude.ai backend are), probe what still fires (other hooks, `session.append` rows), then ask the user for one live check with their login. Without it, the deciding claim keeps Evidence 4 at most.
5. **Gap analysis.** List the gaps `G1..Gn` that would stall an implementer: storage, lifecycle, failure modes, cost, privacy, conflicts with other issues. Give each a decision. A decision that belongs to the user goes to `AskUserQuestion` or to Open questions.
6. **Review.** Before you design, get a second view of the matrix and the gaps. Reviewer, first that is allowed: the `advisor` tool, an `opus` subagent, a `sonnet` subagent with a fresh context. Never review only yourself. Fix what it finds.
7. **Design.** State shape, hooks or entry points, flows (Mermaid sequence and state diagrams), files to touch, limits, tests. Copy the existing patterns of the repo and name them.
8. **Testing.** Check each claim the design builds on against the PoC logs. Re-run a probe when a claim has no log. Write the implementer's test plan: unit cases from the observed shapes, and a live check.
9. **Score.** Final per-item scores, ranking and overall verdict with `scripts/score.mjs`. Never do the arithmetic by hand.
10. **Final review.** An independent reviewer (same order as step 6) checks every claim against its cited evidence, the verdict gates, and that the output stands alone. Fix every finding, or name it as an open question.
11. **Summary and publish.** Write the KB slug and the issue comment from `templates.md`. If the user forbids repo writes, write the slug in the scratchpad and list the move as a pending step. Show the user the verdict, the weakest items, the open questions, and what was not tested.

## Scoring

Details, levels and a worked example: `scoring.md`. In short:

| Part | Values |
| --- | --- |
| Verdict per item | `Feasible`, `Partial`, `Heuristic`, `Untested`, `Not feasible` |
| Axes per item, 0–5 | Evidence, Ease, Safety |
| Item score, 0–100 | verdict factor × weighted axes |
| Overall | Weighted mean by priority, then gates: a `Must` that is `Not feasible` gives **No-go**. A `Must` that is `Untested` gives **Spike first**. |
| Ranking | Items by score, weakest first. The weak end is where the risk is. |

`Feasible`, `Partial` and `Heuristic` need Evidence ≥ 4 on the deciding claim. Below that, the verdict is `Untested`.

## Decision models

If `jev_*` tools (TypeSafe Jev) or another decision model are in your tool list, steps 3, 9 and 10 **must** use them. These judgments repeat across many items, which is the case these models are made for. Load the `jev` skill first. One `jev_ask` per item is one call, so the budget is not a reason to skip. If you skip, write why under "How the study was run".

| Step | Use |
| --- | --- |
| 2 Research | `jev_triage` over the KB, spec and source paths with your question. Open only the files it ranks as relevant. |
| 3, 9 Score | One `jev_ask` per item. State: the item, its mechanism and the evidence. Questions: a `score` for Ease, a `score` for Safety, a `classify` for the verdict. Use the levels in `scoring.md`. |
| 10 Final review | One `jev_check` per claim: "Does this cited evidence support this claim?" State: the claim and the cited excerpt. |

Rules:

- The `jev_*` tools may be deferred. Load them with `ToolSearch` first.
- Evidence comes from the tag, not from Jev. Arithmetic and gates stay in `scripts/score.mjs`.
- A Jev answer is a proposal. You own the score. An answer of `review`, `abstain` or `uncertain` means: read the evidence yourself, then decide. When you choose another value than an `act` answer, say why.
- Record every judgment in the Judgments table of `feasibility.md` (see `templates.md`).
- Without a decision model, make the same judgments yourself and write a one-line reason per score.

## Excuses that skip the PoC

| Excuse | Reality |
| --- | --- |
| "The types file describes the shape" | The types file is not a run. It lists fields that a run may never set, and an error result can have another shape (a string, not the typed object). Probe it. |
| "A probe runs real model turns" | The fake-API harness plays a fixed script. No model, no login, seconds per run. |
| "The budget is tight" | Then score the item `Untested`, and make the overall verdict say so. Never round up. |
| "It is read-only work" | Probes go in the scratchpad and a private tmux socket. The repo stays clean. |
| "I will list it as a risk" | A risk on a deciding spike is an `Untested` verdict, not a footnote. |
| "The tool does not exist under the fake API" | Probe what still fires, then ask the user for one live check. Do not mine saved transcripts without a yes. |

## Common mistakes

| Mistake | Fix |
| --- | --- |
| "Feasible, build it" from reading code | Apply the Evidence ≥ 4 rule. Run the PoC. |
| One word for the whole feature | Score each item, then the overall. Show the ranking. |
| Claim says "observed" for something not observed | Final review checks every claim against its log. Write what the run really showed. |
| Evidence only in `/tmp` | Save it under `docs/knowledge-base/<slug>/sources/`. Scrub user names. Drop system-prompt text. |
| Probe leftovers (containers, sessions, processes) | List them, remove only yours, check again. |
| Design without the user's decisions | Ask with `AskUserQuestion`, or list them under Open questions. |
