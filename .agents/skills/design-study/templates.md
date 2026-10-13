# Output templates

Two outputs: a KB slug that keeps the evidence, and an issue comment that an implementer reads. Fill every slot. Write "None" when a slot is empty; never drop it.

## KB slug: `docs/knowledge-base/<slug>/`

Follow `docs/knowledge-base/AGENTS.md`. Add a row for the slug there.

| File | Holds |
| --- | --- |
| `AGENTS.md` and a `CLAUDE.md` symlink | Read order, source of truth, safety rules for new probes. |
| `README.md` | Scope, version pins, the requirement items, the overall verdict. |
| `feasibility.md` | The matrix (one row per item), the spike answers, the score table from `scripts/score.mjs`, and a Judgments table: item, axis, decision-model answer and confidence (or "own"), chosen value, reason. |
| `open-questions.md` | Unknowns and decisions that the user still has to make. Keep the numbers stable. |
| `sources/<probe>-<date>/` | Probe mod, fake API, turn scripts, event logs. Scrubbed (see `probing.md`). |

## Issue comment

Post with `gh issue comment <N> --body-file <file>` only when the user asked for it. Else show the file and ask. Keep it under 60,000 characters. Inline the observed shapes that the design needs, so the comment stands alone.

```markdown
## Design study: <feature>

**Overall: <Go | Go with caveats | Spike first | Rethink scope | No-go>** (weighted mean <n>/100). <One sentence: why.>
Not tested: <items and spikes without a run>.

<details><summary>How the study was run</summary>
Versions, probe method, runs, where the evidence is saved. Reviewers used. Decision model used (or why not).
</details>

### 1. Score
<score.mjs output: items ranked weakest first, overall line, evidence-rule notes>

### 2. Feasibility per item
| Item | Priority | Verdict | Mechanism | Caveat | Evidence |

### 3. Spikes
| # | Question | Answer | Tag |

<details><summary>Observed shapes</summary>
Code blocks the implementer can copy into tests.
</details>

### 4. Gaps and decisions
| # | Gap | Decision |

### 5. Design
State, entry points and hooks, flows (Mermaid), limits.

### 6. Files to touch
| File | Change |

### 7. Tests
Unit cases per module, and a live check.

### 8. Changes to the acceptance criteria
### 9. Open questions
Decisions for the user. Then "Decided without the user": each default you took, and why.
### 10. Related
```
