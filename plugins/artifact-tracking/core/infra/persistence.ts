// Persistence: the only writer of the plugin store. Keys: `v2:s:<id>`, `v2:index`, `v2:run` (spec 5.13).
// It writes through with a debounce, bounds the total size, and writes the leaving session at `session.end`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.6 and 5.13. Plan decisions D1 to D3.

import type { Json } from '../interfaces/items'
import type { StorePort, Timer } from '../interfaces/ports'
import type { DataSlot, PendingEnd, RunCopy, SessionCopy, Snapshot } from '../interfaces/slots'

export const KEYS = { session: (id: string) => `v2:s:${id}`, index: 'v2:index', run: 'v2:run' } as const

/** Under this budget `session.end` writes nothing: the exit is too close. */
export const MIN_END_BUDGET_MS = 200

/** What the engine's store holds in all (E18: 4 MiB of JSON text), less a margin. A write that would pass it makes room first. */
export const ENGINE_STORE_CHARS = 4_000_000

export interface PersistenceDeps {
  store: StorePort
  clock: { now(): Promise<number>; after(ms: number, fn: () => void): Timer }
  sessionId(): Promise<string>
  slots(): readonly DataSlot[]
  limits(): { flushMs: number; keepSessions: number; maxBytes: number }
  /** A flush is an entry: the session check runs first. */
  beforeFlush(): Promise<void>
  log(line: string): void
}

const size = (v: Json | undefined): number => (v === undefined ? 0 : JSON.stringify(v).length)
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The persisted slots as a stored copy, and whether any of them holds something worth a write. */
function copyOf(entries: readonly (readonly [DataSlot, Json | undefined])[]): { copy: SessionCopy; hasData: boolean } {
  const copy: Record<string, Json> = {}
  let hasData = false
  for (const [slot, v] of entries) {
    if (!slot.persist || v === undefined) continue
    copy[slot.id] = v
    if (!slot.empty(v)) hasData = true
  }
  return { copy, hasData }
}

export class Persistence {
  private timer: Timer | null = null
  /** `clock.now()` when `timer` was armed. */
  private armedAt = 0
  /** The JSON last written for each session id: an equal copy is not written again. */
  private readonly written = new Map<string, string>()
  /** The size of each stored copy. Learned from the store once per load, then kept. */
  private readonly sizes = new Map<string, number>()
  private runSize: number | undefined

  constructor(private readonly d: PersistenceDeps) {}

  /**
   * A persisted slot changed. The first change arms a timer and later ones do not move it, so a burst makes one write.
   * A timer that the engine refused never runs, so one pending for over two periods is replaced. Never rejects.
   */
  async touch(): Promise<void> {
    try {
      const { flushMs } = this.d.limits()
      if (this.timer) {
        const now = await this.d.clock.now()
        if (this.timer && now - this.armedAt <= 2 * flushMs) return
        this.timer?.cancel()
        this.timer = null
      }
      // The engine runs the callback and ignores what it returns; the mini clock of the tests awaits it.
      const timer: Timer = this.d.clock.after(flushMs, (async () => {
        if (this.timer === timer) this.timer = null
        try {
          await this.flush()
        } catch {
          // A failed copy is retried by the next change.
        }
      }) as () => void)
      this.timer = timer
      this.armedAt = await this.d.clock.now()
    } catch {
      // No copy this time. The next change tries again.
    }
  }

  /** Writes at once. Rejects when a slot cannot be read; a rejected store write is logged instead. */
  async flushNow(): Promise<void> {
    this.cancel()
    await this.flush()
  }

  /** The stored copy of `id`. A failed read is logged and counts as no copy: the caller goes on without it. */
  async read(id: string): Promise<SessionCopy | undefined> {
    try {
      return (await this.d.store.get(KEYS.session(id))) as SessionCopy | undefined
    } catch (e) {
      this.d.log(`store: read of ${KEYS.session(id)} failed: ${reason(e)}`)
      return undefined
    }
  }

  /**
   * Stores one session's copy and puts its id first in the index. Keeps `keepSessions` ids, and drops the oldest
   * others until the copies, the index and `v2:run` fit `maxBytes`. The copy itself always stays. `runChars` is the
   * size of the `v2:run` that is about to replace the stored one. The copy is written before the dropped sessions
   * are deleted, so a refused write loses no history. When the store would hold the dropped and the new copies
   * together over its own bound, the dropped ones go first. Never rejects.
   */
  async write(id: string, copy: SessionCopy, runChars?: number): Promise<void> {
    const json = JSON.stringify(copy)
    if (this.written.get(id) === json) return
    try {
      const { keepSessions, maxBytes } = this.d.limits()
      const index = ((await this.d.store.get(KEYS.index)) as string[] | undefined) ?? []
      const all = [id, ...index.filter(x => x !== id)]
      const dropped = all.slice(Math.max(1, keepSessions))
      const kept = all.slice(0, Math.max(1, keepSessions))
      this.sizes.set(id, json.length)
      for (const x of kept) if (!this.sizes.has(x)) this.sizes.set(x, size(await this.d.store.get(KEYS.session(x))))
      const run = runChars ?? (await this.runBytes())
      const total = () => kept.reduce((n, x) => n + (this.sizes.get(x) ?? 0), 0) + JSON.stringify(kept).length + run
      while (kept.length > 1 && total() > maxBytes) dropped.push(kept.pop() as string)
      let held = 0
      for (const x of dropped) held += this.sizes.get(x) ?? size(await this.d.store.get(KEYS.session(x)))
      const roomFirst = total() + held > ENGINE_STORE_CHARS
      if (roomFirst) await this.drop(dropped)
      await this.d.store.set(KEYS.session(id), copy)
      if (!roomFirst) await this.drop(dropped)
      if (JSON.stringify(kept) !== JSON.stringify(index)) await this.d.store.set(KEYS.index, kept)
      this.written.set(id, json)
    } catch (e) {
      this.written.delete(id)
      this.sizes.delete(id) // the stored size is not the new one: learn it again
      this.d.log(`store: write of ${KEYS.session(id)} failed: ${reason(e)}`)
    }
  }

  /**
   * `session.end`: cancels the pending flush and settles every slot against the stored copy of `id`. With enough
   * budget it writes the persisted part and `v2:run` (the pending end and the `persist: false` slots). Returns the
   * snapshot of all slots either way, for the switch that follows.
   */
  async end(id: string, budgetMs: number, pending: PendingEnd): Promise<Snapshot> {
    this.cancel()
    const stored = await this.read(id)
    const settled: [DataSlot, Json | undefined][] = []
    for (const slot of this.d.slots()) settled.push([slot, await slot.settle(await slot.read(), stored?.[slot.id])])
    if (budgetMs >= MIN_END_BUDGET_MS) {
      const { copy, hasData } = copyOf(settled)
      const run = settled.filter(([s, v]) => !s.persist && v !== undefined).map(([s, v]) => [s.id, v] as const)
      const record: RunCopy = {
        pendingEnd: pending,
        ...(run.length > 0 ? { run: Object.fromEntries(run) as Record<string, Json> } : {}),
      }
      if (hasData) await this.write(id, copy, size(record)) // the bound counts the run record that follows
      await this.setRun(record)
    }
    return { from: id, slots: Object.fromEntries(settled.map(([s, v]) => [s.id, v])) }
  }

  /** The `v2:run` record. A failed read is logged and answers an empty record. The size stays as it was. */
  async loadRun(): Promise<RunCopy> {
    try {
      const run = (await this.d.store.get(KEYS.run)) as RunCopy | undefined
      this.runSize = size(run)
      return run ?? {}
    } catch (e) {
      this.d.log(`store: read of ${KEYS.run} failed: ${reason(e)}`)
      return {}
    }
  }

  /** After the switch: drops `pendingEnd` and keeps the run values. Nothing left means no key. */
  async clearRun(): Promise<void> {
    const { pendingEnd, ...rest } = await this.loadRun()
    if (pendingEnd === undefined) return
    if (rest.run !== undefined) return this.setRun(rest)
    await this.d.store.delete(KEYS.run)
    this.runSize = 0
  }

  /** `/track clear`: removes the copy and its place in the index. The next equal copy is written again. */
  async forget(id: string): Promise<void> {
    this.written.delete(id)
    this.sizes.delete(id)
    await this.d.store.delete(KEYS.session(id))
    const index = ((await this.d.store.get(KEYS.index)) as string[] | undefined) ?? []
    if (index.includes(id))
      await this.d.store.set(
        KEYS.index,
        index.filter(x => x !== id),
      )
  }

  /** Deletes the keys of the old layout (`s:*` and `index`). Writes no marker. Returns how many it deleted. */
  async dropLegacy(): Promise<number> {
    const old = (await this.d.store.keys()).filter(k => k === 'index' || k.startsWith('s:'))
    for (const k of old) await this.d.store.delete(k)
    return old.length
  }

  /** Deletes the stored copies of sessions that fell out of the index. */
  private async drop(ids: readonly string[]): Promise<void> {
    for (const x of ids) {
      await this.d.store.delete(KEYS.session(x))
      this.sizes.delete(x)
      this.written.delete(x)
    }
  }

  private cancel(): void {
    this.timer?.cancel()
    this.timer = null
  }

  private async flush(): Promise<void> {
    await this.d.beforeFlush() // a /clear since the last change: the check saves the old session first
    const entries: [DataSlot, Json | undefined][] = []
    for (const slot of this.d.slots()) if (slot.persist) entries.push([slot, await slot.read()])
    const { copy, hasData } = copyOf(entries)
    if (!hasData) return // after /track clear: never replace a stored copy with an empty one
    await this.write(await this.d.sessionId(), copy)
  }

  private async runBytes(): Promise<number> {
    this.runSize ??= size(await this.d.store.get(KEYS.run))
    return this.runSize
  }

  private async setRun(run: RunCopy): Promise<void> {
    try {
      await this.d.store.set(KEYS.run, run)
      this.runSize = size(run)
    } catch (e) {
      this.d.log(`store: write of ${KEYS.run} failed: ${reason(e)}`)
    }
  }
}
