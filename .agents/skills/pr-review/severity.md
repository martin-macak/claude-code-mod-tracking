# Severity

Every finding has one level. The text of a level is also the option text for the decision model (`jev_classify`). `workflow.js` copies it in `SEVERITY_TEXT`; a test keeps both equal.

| Level | Text |
| --- | --- |
| `Critical` | Wrong behavior, data loss, a privacy leak, a crash or a blocked session, or a `Must` item not implemented. Blocks the merge. |
| `Major` | A requirement only partly met, changed behavior without a test, or a design flaw that will force a rework. Fix before the merge. |
| `Minor` | A quality or clarity problem with low risk. Fix in this PR when cheap, else file a follow-up. |
| `Nit` | Style or wording. Optional. |

## Review verdict

| Verdict | When |
| --- | --- |
| **Not ready** | Any `Critical` finding. |
| **Ready after fixes** | No `Critical`, at least one `Major`. |
| **Ready** | Only `Minor` and `Nit`, or none. |

## Open requirement items

An item that is not `Implemented` and has no finding gets one from this table (`GAP` in `workflow.js`):

| Status | Must | Should | Could |
| --- | --- | --- | --- |
| Not implemented | `Critical` | `Major` | `Minor` |
| Partial | `Major` | `Major` | `Minor` |
| Inconclusive | `Minor` | `Minor` | `Minor` |

## Jev call for one finding

One state, one subject: the finding.

```json
{
  "state": {
    "finding": "R2 Bash `git -C` with a relative path joins onto `~/...` as `/~/...`",
    "code": "plugins/artifact-tracking/hooks/repos/shell.ts:88  const dir = join(cwd, arg)"
  },
  "questions": [
    {
      "id": "severity",
      "type": "classify",
      "question": "How severe is this finding for the merge?",
      "options": {
        "Critical": "<Critical text>",
        "Major": "<Major text>",
        "Minor": "<Minor text>",
        "Nit": "<Nit text>"
      }
    }
  ]
}
```

Fill `options` with the full texts from the first table.
