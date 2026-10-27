// The words and the arguments of `/track clean` (issue #122): the parser of the arguments, the plan by kind with its
// `skipped: <reason>` lines, the text of an applied cleanup and the text of the audit log. Pure: no ports, no trackers.
// The plan caps each kind at 10 lines and counts the rest, the C6 rule of `problemsText` (core/infra/command-text.ts).
// The plan is one list of typed lines (issue #199): `planLines` makes it, `planLinesText` joins it for the reply, and the pane
// reads the same list.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design study: issue #49, section 5.5.

import type { CleanAction, CleanKind, CleanStep, LogEntry, PlanLine, PlanRole } from '../interfaces/clean'

export type { PlanLine, PlanRole } // the types live in core/interfaces/clean.ts: the pane view (ux/) imports them from there

/** The kinds `--yes` accepts, in the order the plan lists them. */
export const CLEAN_KINDS: readonly CleanKind[] = ['tasks', 'containers', 'worktrees']

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

const TITLES: Readonly<Record<CleanKind, string>> = { tasks: 'Tasks', containers: 'Containers', worktrees: 'Worktrees' }
/** `remove-worktree` says what git does to the folder: it takes the ignored files with it (owner decision Q2 of issue #123). */
const ACTION_WORDS: Readonly<Record<CleanAction, string>> = {
  stop: 'stop',
  'remove-record': 'remove record',
  'remove-worktree': 'remove worktree (if clean and merged; deletes ignored files)',
  'remove-container': 'remove',
}

/** How many lines of one kind the text shows before it counts the rest. */
const SHOWN = 10
/** How many entries of the log the text shows. */
const LOG_SHOWN = 50

const HIDE_HINT = 'Hide: /track clean --hide hides every ended row now, and /track show-all shows them again.'
const LOG_HINT = 'Log: /track clean --log'

/** A line from a text of this module: one row, so no newline to split. */
const plain = (role: PlanRole, text: string): PlanLine => ({ role, text })

/**
 * The lines of a text that comes from outside the module (a step label, the message of a failure): one line for each row, in
 * the same role. A line holds one row, so a view can count rows for each line. The rows after the first say that they go on
 * with the row above (`cont`), so a view still counts one step. The joined text keeps its bytes.
 */
const rowsOf = (role: PlanRole, text: string): PlanLine[] =>
  text.split('\n').map((row, i) => (i === 0 ? plain(role, row) : { ...plain(role, row), cont: true }))

/** The words of one line: `<label>: <action>` in a plan, `<label>: <outcome>` once applied. A step with a reason is skipped. */
function lineText({ step, outcome }: Line): string {
  const what = outcome ?? (step.skip !== undefined ? `skipped: ${step.skip}` : ACTION_WORDS[step.action])
  return `  ${step.label}: ${what}`
}

/** The lines by kind, each kind under a head. `head` writes the head of a kind. Over `SHOWN`, the first ones and a count. */
function sections(lines: readonly Line[], head: (kind: CleanKind) => string, kinds = CLEAN_KINDS): PlanLine[] {
  const out: PlanLine[] = []
  for (const kind of kinds) {
    const of = lines.filter(l => l.step.kind === kind)
    if (of.length === 0) continue
    out.push(plain('head', head(kind)), ...of.slice(0, SHOWN).flatMap(l => rowsOf('step', lineText(l))))
    if (of.length > SHOWN) out.push({ ...plain('more', `  and ${of.length - SHOWN} more.`), count: of.length - SHOWN })
  }
  return out
}

/** The trackers whose plan failed, one line each, under `Problems:`. */
const problems = (failed: readonly string[]): PlanLine[] =>
  failed.length === 0
    ? []
    : [plain('blank', ''), plain('head', 'Problems:'), ...failed.flatMap(f => rowsOf('problem', `  ${f}`))]

/** The words of each line, without the role. */
const texts = (lines: readonly PlanLine[]): string[] => lines.map(l => l.text)

/** The text of a list of lines: one row each. The one place that makes the reply of `/track clean` from the lines. */
export const planLinesText = (lines: readonly PlanLine[]): string => texts(lines).join('\n')

/** What a cleanup would do, by kind, as typed lines. Nothing changes. The reply of `/track clean` and the pane read this list. */
export function planLines(lines: readonly Line[], failed: readonly string[]): readonly PlanLine[] {
  const body = sections(lines, kind => `${TITLES[kind]} (apply with /track clean --yes ${kind})`)
  return [
    plain('title', 'Clean plan. Nothing changed.'),
    plain('blank', ''),
    ...(body.length > 0 ? body : [plain('head', 'Nothing to stop or remove.')]),
    ...problems(failed),
    plain('blank', ''),
    plain('hint', HIDE_HINT),
    plain('hint', LOG_HINT),
  ]
}

/**
 * The plan as one text, from the steps: the reference that tests and contracts compare with. `/track clean` prints
 * `planLinesText(await cleanPlan(p))`, the same text.
 */
export function planText(lines: readonly Line[], failed: readonly string[]): string {
  return planLinesText(planLines(lines, failed))
}

/** The reply of `/track clean --yes <kind>...`: each step of the kinds that ran, with its outcome. */
export function resultText(kinds: readonly CleanKind[], lines: readonly Line[], failed: readonly string[]): string {
  const body = texts(sections(lines, kind => TITLES[kind], kinds))
  return [
    `Cleaned: ${kinds.join(', ')}.`,
    '',
    ...(body.length > 0 ? body : ['Nothing to do.']),
    ...texts(problems(failed)),
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
