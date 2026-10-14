# Review template

The synthesis agent fills this. Fill every slot. Write "None" when a slot is empty; never drop it. Keep the body under 60,000 characters: collapse the Nit section into `<details>` first.

Number the findings per level: `C1`, `M1`, `m1`, `n1`. Each one gives a place, the problem, the evidence and a fix. Use a GitHub `suggestion` block when the fix replaces the cited lines.

```markdown
## PR review: <PR title>

**Verdict: <Ready | Ready after fixes | Not ready>.** <One sentence: why.>
Requirements: <n Implemented> of <n> implemented (open `Must`: <ids or None>). Findings: <n> Critical, <n> Major, <n> Minor, <n> Nit.

### 1. Requirements

| Item | Priority | Study | Status | Correct | Code | Test |
| --- | --- | --- | --- | --- | --- | --- |
| R1 <text> | Must | Feasible 84 | Implemented | yes | `path:line` | `path` "test name" |

### 2. Reassessed items

<score.mjs output for the reassessed items>

| Item | Was | Now | What was missed | Proposal |
| --- | --- | --- | --- | --- |

### 3. Findings

#### Critical

**C1 <title>** (`path:line`, <lens>, <item>)
Problem: <one or two sentences>.
Evidence: <quoted code or test output>.
Fix: <snippet, or a suggestion block>

#### Major

**M1 …**

#### Minor

**m1 …**

#### Nit

**n1 …**

<details><summary>How the review ran</summary>

- Issue: #<n> (<closing | keyword | refs | none>).
- Design: <study with n items | draft without scores | none>.
- Agents: <n> trace, <n> reassess, 3 lens, <n> verify, <0 or 1> dedup, 1 synthesis. Models: trace, lens, verify and dedup `sonnet`; reassess and synthesis `opus`.
- Merged duplicates: <n, with their lenses, or None>.
- Decision model: <Jev, with the count of `jev` and `own` judgments per stage | own judgment, because …>.
- Refuted findings: <n, titles>.
- Dropped: <labels and why, or None>.
- Not covered: <files or items, or None>.

</details>
```
