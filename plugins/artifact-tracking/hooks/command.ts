// `/track`: the empty command, `refresh`, `clear` and `prio`. The manager and the item runtime do the work; this holds
// only the order of the calls and the text of the answer. Every other word prints the usage line.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.3 and 5.12. Plan: L3 Task 12, D12.

import type { LifecycleManager } from '../core/infra/lifecycle'
import type { Ports } from '../core/interfaces/ports'
import type { ItemRuntime } from './items/runtime'
import { composeCommandText } from './ui/auto-view'
import { viewInputs } from './view-inputs'

const USAGE = 'Usage: /track [refresh|clear|prio <ref> <high|normal|low|auto>]'
/** `/track prio` levels: `auto` removes the person's mark. */
const PRIO_WORDS = new Set(['high', 'normal', 'low', 'auto'])

/** The text of the list. It waits for the repo first, so `#N` keys are right. */
async function listText(p: Ports, m: LifecycleManager, items: ItemRuntime): Promise<string> {
  await items.ensureRepo()
  const v = await viewInputs(p, m.facts, {})
  return composeCommandText(v.items, v.processes, v.processUi, v.ctx, v.repos)
}

/**
 * Answers one `/track <args>`. The command is not passed on (D12): it is the implementation of the command.
 * A failure rejects; the hook turns it into one line of text.
 */
export async function trackCommand(
  p: Ports,
  m: LifecycleManager,
  items: ItemRuntime,
  args: string,
): Promise<{ text: string }> {
  await m.entry(p)
  if (!items.ready) return { text: 'artifact-tracking: not ready.' }
  const arg = args.trim().toLowerCase()
  if (arg === '') {
    // In `claude -p` the command may run before acli answers `--version`. The probes are cached.
    // Wait for them and for the repo first, so the pane's first drawing is already right (also after /clear).
    await items.settleProbes()
    await items.ensureRepo()
    await m.command(p, { sub: '', args: '', wait: true })
    if (!(await p.ui.open())) p.ui.toast('Widen the terminal to see the tracking pane')
    items.kick('open')
    return { text: await listText(p, m, items) }
  }
  if (arg === 'refresh') {
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
    if ((await items.prio(ref, word)) === 'not-tracked') return { text: `Not tracked: ${ref}` }
    try {
      await m.flushNow() // `claude -p` can exit right after the reply: save now, not after flushMs
    } catch {
      // The next change saves it.
    }
    return { text: await listText(p, m, items) }
  }
  return { text: USAGE }
}
