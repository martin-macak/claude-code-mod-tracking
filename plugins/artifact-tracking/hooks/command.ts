// `/track`: the empty command, `refresh`, `clear` and `prio`. The manager and the item host do the work; this holds
// only the order of the calls and the text of the answer. Every other word prints the usage line.
// A reply that prints the list ends with the problems of the config file, when there are any (until the help view of L6).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.3, 5.7 and 5.12. Plan: L3 Task 12, D12. L4 Task 6, C6.

import type { LifecycleManager } from '../core/infra/lifecycle'
import type { ItemsHost, Priority } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import { composeCommandText } from './ui/auto-view'
import { viewInputs } from './view-inputs'

const USAGE = 'Usage: /track [refresh|clear|prio <ref> <high|normal|low|auto>]'
/** `/track prio` levels: `auto` removes the person's mark. */
const PRIO_WORDS = new Set(['high', 'normal', 'low', 'auto'])

/** How many problems the block names before it counts the rest. */
const SHOWN_PROBLEMS = 10

/**
 * The config problems as a block: a header with the path, then each problem on its own line, indented two spaces. Over
 * ten, the first ten and a count. Empty text when all is well.
 */
export function problemsText(path: string | undefined, problems: readonly string[]): string {
  if (problems.length === 0) return ''
  const rest = problems.length - SHOWN_PROBLEMS
  return [
    path === undefined ? 'Config problems:' : `Config problems in ${path}:`,
    ...problems.slice(0, SHOWN_PROBLEMS).map(p => `  ${p}`),
    ...(rest > 0 ? [`  and ${rest} more ${rest === 1 ? 'problem' : 'problems'}.`] : []),
  ].join('\n')
}

/** The text of the list, then the config problems after one blank line. It waits for the repo first, so `#N` keys are right. */
async function listText(p: Ports, m: LifecycleManager, items: ItemsHost): Promise<string> {
  await items.prepare()
  const v = await viewInputs(p, m.facts, { live: id => m.live(id) })
  const text = composeCommandText(v.items, v.processes, v.processUi, v.ctx, v.repos)
  const problems = problemsText(m.config.path(), m.config.problems())
  return problems === '' ? text : `${text}\n\n${problems}`
}

/**
 * Answers one `/track <args>`. The command is not passed on (D12): it is the implementation of the command.
 * A failure rejects; the hook turns it into one line of text.
 */
export async function trackCommand(
  p: Ports,
  m: LifecycleManager,
  items: ItemsHost,
  args: string,
): Promise<{ text: string }> {
  await m.entry(p)
  if (!items.ready) return { text: 'artifact-tracking: not ready.' }
  const arg = args.trim().toLowerCase()
  if (arg === '') {
    await m.refreshConfig(p) // the file may have changed since the last check: its problems and toggles show now
    // In `claude -p` the command may run before acli answers `--version`. The probes are cached.
    // Wait for them and for the repo first, so the pane's first drawing is already right (also after /clear).
    await items.settle()
    await items.prepare()
    await m.command(p, { sub: '', args: '', wait: true })
    if (!(await p.ui.open())) p.ui.toast('Widen the terminal to see the tracking pane')
    items.kick('open')
    return { text: await listText(p, m, items) }
  }
  if (arg === 'refresh') {
    await m.refreshConfig(p)
    await items.refreshAll()
    // The trackers refresh too: the auto tracker runs a round and waits for it and its PR step.
    await m.command(p, { sub: 'refresh', args: '', wait: true })
    return { text: await listText(p, m, items) }
  }
  if (arg === 'clear') {
    // The auto tracker hides its current items first, so the next tick does not bring them back (A14).
    await m.command(p, { sub: 'clear', args: '', wait: true })
    await m.clear(p)
    return { text: 'Tracking list cleared.' }
  }
  // R11: the pane's keys for `claude -p`. The ref keeps its case: Jira keys and repo names need it.
  const prio = /^prio\s+(\S+)\s+(\S+)$/i.exec(args.trim())
  const word = prio?.[2]?.toLowerCase()
  if (prio && word !== undefined && PRIO_WORDS.has(word)) {
    const ref = prio[1] ?? ''
    const id = await items.rowIdOf(ref)
    if (id === undefined) return { text: `Not tracked: ${ref}` }
    await items.setPriority(id, word === 'auto' ? undefined : (word as Priority))
    try {
      await m.flushNow() // `claude -p` can exit right after the reply: save now, not after flushMs
    } catch {
      // The next change saves it.
    }
    return { text: await listText(p, m, items) }
  }
  return { text: USAGE }
}
