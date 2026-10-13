# Scoring a design study

Score each requirement item, rank the items, then score the whole feature. `scripts/score.mjs` does the arithmetic and the gates.

## Verdict per item

| Verdict | Meaning | Factor |
| --- | --- | --- |
| `Feasible` | A tested path does it as written. | 1.00 |
| `Partial` | The mechanism is exact, but it covers only a named subset of the cases. The caveat names the cases left out. | 0.75 |
| `Heuristic` | The mechanism guesses, so it can be wrong in any case it covers. The caveat names the bounds of the guess. | 0.50 |
| `Untested` | No run decided it yet. | 0.30 |
| `Not feasible` | No path exists. | 0.00 |

Rule: `Feasible`, `Partial` and `Heuristic` need Evidence ≥ 4 on the deciding claim. The script lowers the verdict to `Untested` when Evidence is below 4, and says so.

## Axes, 0–5

Each level stands alone. Use the same text as Jev `levels`, lowest first.

**Evidence** (from the claim tags; never from a model):

| Level | Text |
| --- | --- |
| 0 | No evidence. |
| 1 | A guess with no source. |
| 2 | An inference from reading code or docs, not run. |
| 3 | Public docs or a changelog state it. |
| 4 | A primary source states it (types file, CLI help), or a passing repo test covers the same path, and nothing observed contradicts it. |
| 5 | Observed in a saved run of the real tool, at the point the design hooks into (for example the hook result, not only the tool's own output). |

Mixed evidence: when the cases in scope have different evidence (observed on macOS, inferred on Linux), split the item per case. Each part gets the priority of its own case: a case that the issue does not require is `Could`. A case is in scope when the issue or the user needs it. Else name it as out of scope in the caveat and do not score it. Never use the strongest level for the whole item.

Mixed mechanism: one guessing step makes the whole item `Heuristic`, even when the other steps are exact.

Repo code that you only read is level 2. Real output saved from another place than the hook point (a transcript the user gave you) is level 4 for the hook-side claim.

**Ease** (how much work and how much new code):

| Level | Text |
| --- | --- |
| 0 | Needs a change outside this repo (engine, upstream tool). |
| 1 | Needs a new subsystem with no pattern in the repo. |
| 2 | Needs new code across many modules and new state. |
| 3 | Copies an existing pattern with new state or a new module. |
| 4 | Extends an existing module with a small change. |
| 5 | Configuration or one small function. |

**Safety** (risk to the user's session, data, privacy and speed):

| Level | Text |
| --- | --- |
| 0 | Can break the session or lose user data. |
| 1 | Can block the session, or leak private data, when it fails. |
| 2 | Adds noticeable cost on a hot path, or shows wrong state often. |
| 3 | Can show wrong or stale state in rare cases. |
| 4 | Fails soft. The worst case is a missing row or a short delay. |
| 5 | No side effects and no hot-path cost. |

## Item score

```text
score = 100 × factor(verdict) × (0.5 × Evidence + 0.3 × Ease + 0.2 × Safety) / 5
```

Priority weight: `Must` 3, `Should` 2, `Could` 1.

## Overall

1. Weighted mean of the item scores, by priority weight.
2. Gates, in this order. The first that matches wins:
   - A `Must` item is `Not feasible` → **No-go**.
   - A `Must` item is `Untested` → **Spike first**.
   - Mean ≥ 75 → **Go**.
   - Mean ≥ 55 → **Go with caveats**.
   - Else → **Rethink scope**.
3. Ranking: all items by score, lowest first. Show the three lowest with their caveat in the summary.

## Input for the script

```json
{
  "feature": "#33 Track background processes",
  "items": [
    { "id": "R1", "name": "Background shells", "priority": "Must", "verdict": "Feasible", "evidence": 5, "ease": 4, "safety": 5 },
    { "id": "R2", "name": "Docker containers", "priority": "Must", "verdict": "Feasible", "evidence": 5, "ease": 3, "safety": 4 },
    { "id": "R3", "name": "tmux and screen", "priority": "Should", "verdict": "Partial", "evidence": 5, "ease": 3, "safety": 4 },
    { "id": "R4", "name": "Detached processes (macOS)", "priority": "Should", "verdict": "Heuristic", "evidence": 5, "ease": 2, "safety": 3 },
    { "id": "R5", "name": "Monitor tasks", "priority": "Could", "verdict": "Untested", "evidence": 4, "ease": 4, "safety": 5 }
  ]
}
```

Run `node .agents/skills/design-study/scripts/score.mjs <file.json>`. It prints a Markdown table (items by score, weakest first), the weighted mean and the overall verdict. Paste the output into the summary as it is.

## Jev call for one item

One state, one subject: the item. Evidence stays out of the questions.

```json
{
  "state": {
    "item": "R4 Detached processes: show processes started with nohup or & that outlive the Bash call",
    "mechanism": "ps sweep after the call: pgid != pid, pgid leader gone, start time in the call window, command matches",
    "evidence": "[observed] two orphans found by the sweep in a saved run; [inference] Linux subreapers untested",
    "repo_patterns": "auto/round.ts probes git on a 30 s tick"
  },
  "questions": [
    { "id": "ease", "type": "score", "question": "How much work is this item for this repo?", "levels": ["<Ease 0 text>", "…", "<Ease 5 text>"] },
    { "id": "safety", "type": "score", "question": "How safe is this item for the user's session, data, privacy and speed?", "levels": ["<Safety 0 text>", "…", "<Safety 5 text>"] },
    { "id": "verdict", "type": "classify", "question": "Which verdict fits the mechanism and its caveat?", "options": { "Feasible": "A tested path does it as written.", "Partial": "The mechanism is exact but covers only a named subset of the cases.", "Heuristic": "The mechanism guesses, so it can be wrong in any case it covers.", "Not feasible": "No path exists." } }
  ]
}
```

Fill `levels` with the full texts from the tables above. Do not offer `Untested` to Jev: the Evidence rule sets it.
