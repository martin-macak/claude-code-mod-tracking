// The words and the arguments of `/track clean` (issue #122): the parser of the arguments, the plan by kind with its
// `skipped: <reason>` lines, the text of an applied cleanup and the text of the audit log. Pure: no ports, no trackers.
// The plan caps each kind at 10 lines and counts the rest, the C6 rule of `problemsText` (core/infra/command-text.ts).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design study: issue #49, section 5.5.

import type { CleanAction, CleanKind, CleanStep, LogEntry } from '../interfaces/clean'

/** The kinds `--yes` accepts, in the order the plan lists them. */
export const CLEAN_KINDS: readonly CleanKind[] = ['tasks', 'worktrees']

/** `/track clean` with an argument that is no mode. */
export const CLEAN_USAGE = `Usage: /track clean [--hide|--log|--yes <${CLEAN_KINDS.join('|')}>...]`

/** What the arguments of `/track clean` ask for. */
export type CleanMode = { mode: 'plan' } | { mode: 'hide' } | { mode: 'log' } | { mode: 'yes'; kinds: CleanKind[] }

/** The arguments after `clean`. `undefined`: no mode, so the reply is the usage line. `--yes` needs a kind, and no mode mixes with another. */
export function parseClean(rest: string): CleanMode | undefined {
  const words = rest.trim().split(/\s+/).filter(Boolean)
  const [first, ...more] = words
  if (first === undefined) return { mode: 'plan' }
  if (first === '--hide') return more.length === 0 ? { mode: 'hide' } : undefined
  if (first === '--log') return more.length === 0 ? { mode: 'log' } : undefined
  if (first !== '--yes' || more.length === 0) return undefined
  const kinds = new Set<CleanKind>()
  for (const w of more) {
    const kind = CLEAN_KINDS.find(k => k === w)
    if (kind === undefined) return undefined
    kinds.add(kind)
  }
  return { mode: 'yes', kinds: [...kinds] }
}

/** One step of a plan, and what applying it gave. `outcome` is absent in a plan that was not applied. */
export interface Line {
  readonly step: CleanStep
  /** `done`, or `skipped: <reason>`. */
  readonly outcome?: string
}

const TITLES: Readonly<Record<CleanKind, string>> = { tasks: 'Tasks', worktrees: 'Worktrees' }
const ACTION_WORDS: Readonly<Record<CleanAction, string>> = { stop: 'stop', 'remove-record': 'remove record' }

/** How many lines of one kind the text shows before it counts the rest. */
const SHOWN = 10
/** How many entries of the log the text shows. */
const LOG_SHOWN = 50

const HIDE_HINT = 'Hide: /track clean --hide hides every ended row now, and /track show-all shows them again.'
const LOG_HINT = 'Log: /track clean --log'

/** The words of one line: `<label>: <action>` in a plan, `<label>: <outcome>` once applied. A step with a reason is skipped. */
function lineText({ step, outcome }: Line): string {
  const what = outcome ?? (step.skip !== undefined ? `skipped: ${step.skip}` : ACTION_WORDS[step.action])
  return `  ${step.label}: ${what}`
}

/** The lines by kind, each kind under a head. `head` writes the head of a kind. Over `SHOWN`, the first ones and a count. */
function sections(lines: readonly Line[], head: (kind: CleanKind) => string, kinds = CLEAN_KINDS): string[] {
  const out: string[] = []
  for (const kind of kinds) {
    const of = lines.filter(l => l.step.kind === kind)
    if (of.length === 0) continue
    out.push(head(kind), ...of.slice(0, SHOWN).map(lineText))
    if (of.length > SHOWN) out.push(`  and ${of.length - SHOWN} more.`)
  }
  return out
}

/** The trackers whose plan failed, one line each, under `Problems:`. */
const problems = (failed: readonly string[]): string[] =>
  failed.length === 0 ? [] : ['', 'Problems:', ...failed.map(f => `  ${f}`)]

/** The reply of `/track clean`: what a cleanup would do, by kind. Nothing changed. */
export function planText(lines: readonly Line[], failed: readonly string[]): string {
  const body = sections(lines, kind => `${TITLES[kind]} (apply with /track clean --yes ${kind})`)
  return [
    'Clean plan. Nothing changed.',
    '',
    ...(body.length > 0 ? body : ['Nothing to stop or remove.']),
    ...problems(failed),
    '',
    HIDE_HINT,
    LOG_HINT,
  ].join('\n')
}

/** The reply of `/track clean --yes <kind>...`: each step of the kinds that ran, with its outcome. */
export function resultText(kinds: readonly CleanKind[], lines: readonly Line[], failed: readonly string[]): string {
  const body = sections(lines, kind => TITLES[kind], kinds)
  return [
    `Cleaned: ${kinds.join(', ')}.`,
    '',
    ...(body.length > 0 ? body : ['Nothing to do.']),
    ...problems(failed),
    '',
    LOG_HINT,
  ].join('\n')
}

/** The reply of `/track clean --log`: the entries as given (newest first), one line each. */
export function logText(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return 'The clean log is empty.'
  const rows = entries
    .slice(0, LOG_SHOWN)
    .map(e => `  ${new Date(e.at).toISOString()}  ${e.by}  ${e.kind}  ${e.id}  ${e.action}  ${e.outcome}`)
  return [
    `Clean log, newest first (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}):`,
    ...rows,
    ...(entries.length > LOG_SHOWN ? [`  and ${entries.length - LOG_SHOWN} more entries.`] : []),
  ].join('\n')
}
