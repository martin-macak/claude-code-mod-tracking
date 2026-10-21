// TurnLedger: what each main-loop turn tracked (issue #69). It opens a record on `turn.start` and commits it on
// `turn.complete`, tells the capture funnel which turn a row or a tool call belongs to, and keeps the entries that the
// funnel reports: the items a turn added and the known items it saw again. The state is the `turns` atom, so a hot reload
// keeps it. `slot` is the persisted copy: Persistence stores it per session and a switch carries it (`/clear`) or loads
// it (`/resume`). All the rules are in `core/lib/turns.ts`, `turn-entries.ts` and `turn-store.ts`; this class only reads
// events, writes the atom and tells Persistence. It also words `/track turn` and gives the band its part. It names no
// tracker and holds no `$`.
// Spec: issue #69, the design study "Show what each turn tracked" (section 5) and the owner decisions of 2026-10-21.

import type { TurnStripMode } from '../interfaces/config'
import type { AgentSpawnEvent, RowEvent, ToolCallEvent, TurnCompleteEvent, TurnStartEvent } from '../interfaces/events'
import type { Json } from '../interfaces/items'
import type { AtomPort } from '../interfaces/ports'
import type { DataSlot } from '../interfaces/slots'
import type { DurationStrip, Sightings, TurnLedger, TurnPort, TurnTarget } from '../interfaces/turns'
import { isRecord } from '../lib/json'
import { isEmpty, keysOf, latestWithEntries } from '../lib/turn-entries'
import { isBare, joinLedgers, ledgerFrom, persisted, persistedChanged } from '../lib/turn-store'
import { durationStrip, stripText } from '../lib/turn-strip'
import { bandCounts, turnText } from '../lib/turn-text'
import {
  called,
  commitTurn,
  emptyLedger,
  noteSightings,
  openTurn,
  personPrompt,
  recordByTurnId,
  recordOf,
  spawned,
  startsTask,
  targetOf,
  taskNotice,
} from '../lib/turns'
import { isPersonPrompt, isTaskNoticeRow } from './doors'
import { reason } from './steps'

export interface TurnLedgerDeps {
  /** The `turns` atom. */
  atom: AtomPort<TurnLedger>
  /** The ledger changed: Persistence writes the session copy soon. */
  persisted(): void
  /**
   * A stored ledger came in (`/resume`, `--continue`, `/clear`): the duration lines that drew before it came have no strip yet,
   * so ask the engine to draw them again (issue #69, P2). An ordinary change needs no ask: the engine redraws a render that
   * read the state it wrote.
   */
  redraw(): void
  /** The id of the current session. A record keeps it, so a later session can call it "earlier". */
  sessionId(): Promise<string>
  /** Epoch ms, wall clock: the time of a record. */
  wall(): number
  log(line: string): void
}

/** The newest turn that tracked anything, as the band and its key read it. */
export type TurnBand = {
  readonly ord: number
  /** `+3 new · 1 seen again`. */
  readonly text: string
  /** The keys of its entries, in the order the turn lists them: what it added, then what it saw again. */
  readonly keys: readonly string[]
}

const stringOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export class TurnLedgerService {
  readonly slot: DataSlot

  constructor(private readonly d: TurnLedgerDeps) {
    this.slot = {
      id: 'turns',
      persist: true,
      // A ledger with no turn holds nothing worth a write: the session copy then has no `turns` member.
      read: async () => this.stored(await d.atom.get()),
      empty: v => {
        const l = ledgerFrom(v)
        return l === undefined || isBare(l)
      },
      settle: async (live, stored) => {
        const [a, b] = [ledgerFrom(live) ?? emptyLedger(), ledgerFrom(stored) ?? emptyLedger()]
        return this.stored(joinLedgers(a, b))
      },
      // Carry (`/clear`) and load (`/resume`) put a stored ledger under the live one: the live record of a turn wins, the
      // ordinals go on from the larger counter. The running turn, the pending prompt and the notice are the live one's.
      restore: async value => {
        const loaded = ledgerFrom(value)
        if (loaded === undefined) return
        await this.change(cur => joinLedgers(cur, loaded))
        this.d.redraw()
      },
      clear: async () => void (await d.atom.update(() => emptyLedger())),
    }
  }

  /** The ledger now. */
  ledger(): Promise<TurnLedger> {
    return this.d.atom.get()
  }

  // ---------------------------------------------------------------- the capture funnel

  /**
   * Which turn the work of a row belongs to (see `rowTarget`). A fault of the ledger is logged and gives `undefined`: the
   * row is not stamped, and the capture and the handlers go on without a turn.
   */
  rowTurn(ev: RowEvent): Promise<TurnTarget | undefined> {
    return this.quiet('row', () => this.rowTarget(ev))
  }

  /** The same for a finished tool call (see `callTarget`): its id also maps to the turn, for the wake of a background task. */
  callTurn(ev: ToolCallEvent): Promise<TurnTarget | undefined> {
    return this.quiet('tool call', () => this.callTarget(ev))
  }

  /**
   * Runs a capture for the turn `target` names: the capture stamps its items with the ordinal and says what it did, the
   * ledger keeps that. A fault of the ledger is logged and never stops the capture. A fault of the capture rejects: the
   * caller's guard logs it, as it did before the ledger.
   */
  async withTurn(target: TurnTarget | undefined, capture: (turn?: number) => Promise<Sightings>): Promise<void> {
    const seen = await capture(target?.ord)
    await this.quiet('entries of a capture', () => this.note(target, seen))
  }

  /**
   * What a tracker handler holds of a turn (issue #133): the ordinal to stamp its rows with, and the call that lists the rows
   * an event named. The target keeps its flags, so work of an agent after its turn ended is marked late. Never rejects.
   */
  portOf(target: TurnTarget): TurnPort {
    return { ord: target.ord, note: async s => void (await this.quiet('slot rows', () => this.note(target, s))) }
  }

  private async quiet<T>(what: string, step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step()
    } catch (e) {
      this.d.log(`turns: ${what} failed: ${reason(e)}`)
      return undefined
    }
  }

  // ---------------------------------------------------------------- events

  /**
   * A row was appended. The person's prompt row opens the pending bucket, a task notice marks the wake that follows. Says
   * which turn the work of the row belongs to: the target of the capture. Undefined: the row is not stamped.
   */
  async rowTarget(ev: RowEvent): Promise<TurnTarget | undefined> {
    const person = isPersonPrompt(ev)
    const l = await this.change(cur =>
      person ? personPrompt(cur, ev.text) : isTaskNoticeRow(ev) ? taskNotice(cur, ev.text) : cur,
    )
    return targetOf(l, { ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {}), person })
  }

  /**
   * A finished tool call. Says which turn its work belongs to. A call that started a task also maps its id to that turn,
   * for the notice that comes when the task ends. Any other call leaves the ledger alone: the map serves the wake of a
   * task, and a write of the session copy for each Read or Edit would buy nothing.
   */
  async callTarget(ev: ToolCallEvent): Promise<TurnTarget | undefined> {
    const who = ev.agentId !== undefined ? { agentId: ev.agentId } : {}
    const l = startsTask(ev.result)
      ? await this.change(cur =>
          called(cur, { ...(ev.toolUseId !== undefined ? { toolUseId: ev.toolUseId } : {}), ...who }),
        )
      : await this.d.atom.get()
    return targetOf(l, who)
  }

  /**
   * A subagent or workflow agent spawned: it and its tool call map to the turn that made the spawn. Says which turn owns the
   * spawn, for the handlers of the spawn (issue #133): the running turn for the main loop, the turn of the parent for a
   * nested spawn. A spawn that no turn owns (the main loop, no turn running) has none: `spawned` still maps the agent to the
   * newest turn, but only for the wake of its end, so the handlers get no turn to stamp their rows with. Undefined: none.
   */
  async spawn(ev: AgentSpawnEvent): Promise<TurnTarget | undefined> {
    const input = isRecord(ev.input) ? ev.input : {}
    const answer = isRecord(ev.answer) ? ev.answer : {}
    const spawn = {
      agentId: stringOf(answer.agentId),
      toolUseId: stringOf(input.tool_use_id),
      parentAgentId: stringOf(input.parentAgentId),
    }
    let owner: TurnTarget | undefined
    await this.change(cur => {
      // The owner comes from the ledger as the spawn found it: the fallback map of `spawned` must not make a turn its owner.
      owner = targetOf(cur, spawn.parentAgentId !== undefined ? { agentId: spawn.parentAgentId } : {})
      return spawned(cur, {
        ...(spawn.agentId !== undefined ? { agentId: spawn.agentId } : {}),
        ...(spawn.toolUseId !== undefined ? { toolUseId: spawn.toolUseId } : {}),
        ...(spawn.parentAgentId !== undefined ? { parentAgentId: spawn.parentAgentId } : {}),
      })
    })
    return owner
  }

  /** A main-loop turn began: a record opens, or a wake reopens the turn that started the task. */
  async start(ev: TurnStartEvent): Promise<void> {
    const [session, at] = [await this.d.sessionId(), this.d.wall()]
    await this.change(cur => openTurn(cur, { turnId: ev.turnId, text: ev.text, session, at }))
  }

  /** A turn ended. The ledger commits the main-loop turn that runs; a subagent's end is not its concern. */
  async complete(ev: TurnCompleteEvent): Promise<void> {
    const input = isRecord(ev.input) ? ev.input : {}
    const turnId = stringOf(input.turnId)
    if (turnId === undefined || input.agentId !== undefined) return
    const at = this.d.wall()
    const row = stringOf(ev.durationRow)
    await this.change(cur =>
      commitTurn(cur, { turnId, reason: input.reason, at, ...(row !== undefined ? { durationRow: row } : {}) }),
    )
  }

  /** What a capture found goes to the turn it belongs to. */
  async note(target: TurnTarget | undefined, s: Sightings): Promise<void> {
    if (target === undefined || isEmpty(s)) return // no engine call for a capture that found nothing
    await this.change(cur => noteSightings(cur, target, s))
  }

  // ---------------------------------------------------------------- what the surfaces read

  /**
   * The reply of `/track turn [n]`. `labels` gives the words of each row the list shows, by item key: the call comes after
   * the ledger and the session are read, as the reply always read them. Absent: the key and the category stand.
   */
  async text(n: number | undefined, labels: () => Promise<ReadonlyMap<string, string> | undefined>): Promise<string> {
    const [ledger, session, words] = [
      await this.ledger(),
      await this.d.sessionId(),
      (await labels()) ?? new Map<string, string>(),
    ]
    return turnText(ledger, n, { session, label: e => words.get(e.k) ?? `${e.c} ${e.k}` })
  }

  /**
   * The newest turn that tracked anything, live while it runs: the band shows it and its key opens it. With `ord`, that turn
   * (the open Button of a strip names its own), whether or not it has entries. Absent: the ledger holds no such turn.
   */
  async band(ord?: number): Promise<TurnBand | undefined> {
    const l = await this.ledger()
    const rec = ord === undefined ? latestWithEntries(l) : recordOf(l, ord)
    return rec === undefined ? undefined : { ord: rec.ord, text: bandCounts(rec), keys: keysOf(rec) }
  }

  /**
   * The text a `turn.complete` hook returns for the main turn `turnId` that just ended, by the mode of `ui.turnStrip`:
   * undefined when there is none (the hook returns what `next` gave). The record of a wake is the starter's, found by no
   * wake's turn id, so a wake gets no line.
   */
  async strip(turnId: string, mode: TurnStripMode): Promise<string | undefined> {
    return mode === 'off' ? undefined : stripText(recordByTurnId(await this.ledger(), turnId), mode)
  }

  /** The strip of the `TurnDuration` line drawn with this `requestId`, the uuid of its `turn_duration` row. Undefined: none. */
  async durationStrip(requestId: string): Promise<DurationStrip | undefined> {
    return durationStrip(await this.ledger(), requestId)
  }

  // ---------------------------------------------------------------- the atom

  /** The ledger as a stored value: `undefined` when it holds no turn. */
  private stored(l: TurnLedger): Json | undefined {
    return isBare(l) ? undefined : (persisted(l) as unknown as Json)
  }

  /**
   * Applies a pure change and writes it, when it changes anything: a read first, so a call that changes nothing is one
   * engine call. The write is version-checked by the atom and `fn` runs again on a retry. Persistence hears of it only when
   * a stored part changed: the pending prompt, the running turn and a notice are not in the session copy, and the next
   * write or the end of the session takes whatever else changed.
   */
  private async change(fn: (cur: TurnLedger) => TurnLedger): Promise<TurnLedger> {
    const cur = await this.d.atom.get()
    const want = fn(cur)
    if (want === cur) return cur
    const next = await this.d.atom.update(fn)
    if (persistedChanged(cur, want)) this.d.persisted()
    return next
  }
}
