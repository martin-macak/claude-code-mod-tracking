// Commands: the router of `/track <args>`. Core answers the empty command, `refresh`, `clear`, `help`, `version`,
// `show-all`, `view`, `turn` and `prio`; then the first sub-command a live tracker declared runs; any other word prints the usage
// line. The host does the work and this holds only the order of the calls and the text of the answer. The list text and
// the help text come in as functions (the draw path is not core). A reply that prints the list ends with the problems
// of the config file, when there are any. The help text lists them itself. The fixed words sit in command-text.ts.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.3, 5.7 and 5.12.
// Plan: L3 Task 12, D12. L4 Task 6, C6. L5 Task 9, K15, K19. L6 Task 12, G14. Issue #65: `version`.

import type { ConfigSource } from '../interfaces/config'
import type { CommandEvent } from '../interfaces/events'
import type { ItemsHost, Priority } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { CommandSpec } from '../interfaces/tracker'
import { isViewId } from '../lib/grouping'
import { TURN_USAGE } from '../lib/turn-text'
import { CORE_HINT, CORE_SUBS, PRIO_WORDS, problemsText, USAGE, VIEW_USAGE, versionText } from './command-text'

export { CORE_HINT, PRIO_WORDS, problemsText, USAGE, VIEW_USAGE, versionText } from './command-text'

/** What the router needs of the rest of core. The LifecycleManager builds it. */
export interface CommandHost {
  /** The first step of every hook that reads session data: the start, the session check. */
  entry(p: Ports): Promise<void>
  readonly items: Pick<ItemsHost, 'ready' | 'prepare' | 'settle' | 'kick' | 'refreshAll' | 'rowIdOf'>
  /** The person's mark on a row: the item host stores it and the prompt text follows (S14). */
  setPriority(p: Ports, rowId: string, level: Priority | undefined): Promise<void>
  /** The `command` event to every live tracker, in `order`. */
  broadcast(p: Ports, ev: CommandEvent): Promise<void>
  /** The sub-commands of the live trackers, in `order`. */
  declared(): readonly { owner: string; spec: CommandSpec }[]
  /** The `command` handler of one tracker. */
  runDeclared(p: Ports, owner: string, ev: CommandEvent): Promise<void>
  /** Opens the pane. It toasts when the terminal has no room. */
  openPane(p: Ports): Promise<void>
  clear(p: Ports): Promise<void>
  flushNow(): Promise<void>
  /** The config file may have changed since the last check. True when it did. */
  refreshConfig(p: Ports): Promise<boolean>
  readonly config: Pick<ConfigSource, 'path' | 'problems' | 'moreProblems'>
  /** The text of turn `n` of the turn ledger, the newest when `n` is absent (issue #69). */
  turnText(p: Ports, n: number | undefined): Promise<string>
  /** The version of the mod, read from its manifest by the start. `undefined` when no start has run it. */
  version(): string | undefined
}

type Reply = { text: string }

export class Commands {
  constructor(
    private readonly host: CommandHost,
    private readonly listText: (p: Ports) => Promise<string>,
    private readonly helpText: (p: Ports) => Promise<string> = async () => '',
  ) {}

  /** `CORE_HINT` while no tracker declares a sub-command, else with `|<sub> <hint>` for each, before the closing `]`. */
  hint(): string {
    const more = [...this.table().values()].map(d => `${d.spec.sub} ${d.spec.hint}`.trim())
    return more.length === 0 ? CORE_HINT : `${CORE_HINT.slice(0, -1)}|${more.join('|')}]`
  }

  /**
   * Answers one `/track <args>`. The command is not passed on (D12): it is the implementation of the command.
   * A failure rejects; the hook turns it into one line of text.
   */
  async run(p: Ports, args: string): Promise<Reply> {
    await this.host.entry(p)
    const arg = args.trim().toLowerCase()
    // Before the ready check: a report from a mod that failed to start must still name its version. The entry has run.
    if (arg === 'version') return { text: versionText(this.host.version()) }
    if (!this.host.items.ready) return { text: 'artifact-tracking: not ready.' }
    if (arg === '') return this.open(p)
    if (arg === 'refresh') return this.refresh(p)
    if (arg === 'help') return this.help(p)
    if (arg === 'show-all') return this.showAll(p)
    const view = /^view(?:\s+(.*))?$/.exec(arg)
    if (view) return this.view(p, view[1])
    if (arg === 'clear') return this.clear(p)
    const turn = /^turn(?:\s+(.*))?$/.exec(arg)
    if (turn) return this.turn(p, turn[1])
    // R11: the pane's keys for `claude -p`. The ref keeps its case: item keys and repo names need it.
    const prio = /^prio\s+(\S+)\s+(\S+)$/i.exec(args.trim())
    const word = prio?.[2]?.toLowerCase()
    if (prio && word !== undefined && PRIO_WORDS.has(word)) return this.prio(p, prio[1] ?? '', word)
    return this.declared(p, args.trim())
  }

  private async open(p: Ports): Promise<Reply> {
    const { host } = this
    await host.refreshConfig(p) // the file may have changed since the last check: its problems and toggles show now
    // In `claude -p` the command may run before a tool answers `--version`. The probes are cached.
    // Wait for them and for the repo first, so the pane's first drawing is already right (also after /clear).
    await host.items.settle()
    await host.items.prepare()
    await host.broadcast(p, { sub: '', args: '', wait: true })
    await host.openPane(p)
    host.items.kick('open')
    return this.list(p)
  }

  private async refresh(p: Ports): Promise<Reply> {
    await this.host.refreshConfig(p)
    await this.host.items.refreshAll()
    // The trackers refresh too: the auto tracker runs a round and waits for it and its PR step.
    await this.host.broadcast(p, { sub: 'refresh', args: '', wait: true })
    return this.list(p)
  }

  /** The help view as text, for `claude -p`. It lists the config problems itself, so the block is not appended. */
  private async help(p: Ports): Promise<Reply> {
    await this.host.refreshConfig(p)
    return { text: await this.helpText(p) }
  }

  /**
   * Shows the rows the TTL hides, or hides them again: a toggle for the session (issue #49). It sets the session atom
   * `hidden`, so `/clear` resets it, and it writes no file. The reply is the list, as the trackers now draw it. It checks
   * the config file first, like `/track` and `/track refresh`: an edit of `hideEnded` or a TTL shows at once.
   */
  private async showAll(p: Ports): Promise<Reply> {
    await this.host.refreshConfig(p)
    const { showAll } = await p.state.hidden.update(cur => ({ ...cur, showAll: !cur.showAll }))
    p.ui.invalidate()
    const { text } = await this.list(p)
    return { text: `${showAll ? 'Showing all rows.' : 'Hiding ended rows again.'}\n\n${text}` }
  }

  /**
   * `/track view <name>` sets the view of the pane for the session (issue #63, L3): the session atom `view`, so `/clear`
   * resets it and no file is written. The reply is the list in that view. It checks the config file first, like `show-all`:
   * the configured views show at once. A name that is no view, no name and more than one word print the usage with the names.
   */
  private async view(p: Ports, word: string | undefined): Promise<Reply> {
    if (word === undefined || !isViewId(word)) return { text: VIEW_USAGE }
    await this.host.refreshConfig(p)
    await p.state.view.update(() => word)
    p.ui.invalidate()
    const { text } = await this.list(p)
    // The text of a view other than by list says the view first. By list does not, so the reply says it, or it would not tell.
    return { text: text.startsWith('View: ') ? text : `View: ${word}\n\n${text}` }
  }

  private async clear(p: Ports): Promise<Reply> {
    // The auto tracker hides its current items first, so the next tick does not bring them back (A14).
    await this.host.broadcast(p, { sub: 'clear', args: '', wait: true })
    await this.host.clear(p)
    // A row tracked again starts plain: not selected and not open.
    await p.state.selected.update(() => null)
    await p.state.expanded.update(() => [])
    return { text: 'Tracking list cleared.' }
  }

  /** `/track turn [n]`: what a turn tracked (issue #69). No pane, no list: the text alone, so every surface and `claude -p` get it. */
  private async turn(p: Ports, word: string | undefined): Promise<Reply> {
    if (word === undefined) return { text: await this.host.turnText(p, undefined) }
    if (!/^[1-9]\d{0,8}$/.test(word)) return { text: TURN_USAGE }
    return { text: await this.host.turnText(p, Number(word)) }
  }

  private async prio(p: Ports, ref: string, word: string): Promise<Reply> {
    const { items } = this.host
    const id = await items.rowIdOf(ref)
    if (id === undefined) return { text: `Not tracked: ${ref}` }
    await this.host.setPriority(p, id, word === 'auto' ? undefined : (word as Priority))
    try {
      await this.host.flushNow() // `claude -p` can exit right after the reply: save now, not after flushMs
    } catch {
      // The next change saves it.
    }
    return this.list(p)
  }

  /** The first tracker that declared the first word runs it with the rest. Any other word is the usage line. */
  private async declared(p: Ports, args: string): Promise<Reply> {
    const [, first = '', rest = ''] = /^(\S+)\s*([\s\S]*)$/.exec(args) ?? []
    const found = this.table().get(first.toLowerCase())
    if (found === undefined) return { text: USAGE }
    await this.host.runDeclared(p, found.owner, { sub: found.spec.sub, args: rest, wait: true })
    return this.list(p)
  }

  /** The declared sub-commands by lower-case sub. The first owner in `order` wins a repeat. Core subs are not here. */
  private table(): ReadonlyMap<string, { owner: string; spec: CommandSpec }> {
    const out = new Map<string, { owner: string; spec: CommandSpec }>()
    for (const d of this.host.declared()) {
      const sub = d.spec.sub.toLowerCase()
      if (!CORE_SUBS.has(sub) && !out.has(sub)) out.set(sub, d)
    }
    return out
  }

  /** The text of the list, then the config problems after one blank line. It waits for the repo first, so `#N` keys are right. */
  private async list(p: Ports): Promise<Reply> {
    await this.host.items.prepare()
    const text = await this.listText(p)
    const { config } = this.host
    const problems = problemsText(config.path(), config.problems(), config.moreProblems())
    return { text: problems === '' ? text : `${text}\n\n${problems}` }
  }
}
