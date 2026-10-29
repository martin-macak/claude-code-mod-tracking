// Persistence: the only writer of the plugin store. Keys: `v2:s:<id>`, `v2:index`, `v2:run` and `v2:log:<run>` (spec 5.13).
// It writes through with a debounce, bounds the total size, and writes the leaving session at `session.end`.
// The audit log of `/track clean` keeps one key for each run, so two sessions that append at once lose nothing (issue #213).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.6 and 5.13. Plan decisions D1 to D3.

import type { LogEntry } from '../interfaces/clean'
import type { Json } from '../interfaces/items'
import type { StorePort, Timer } from '../interfaces/ports'
import type { DataSlot, PendingEnd, RunCopy, SessionCopy, Snapshot } from '../interfaces/slots'
import { isRecord } from '../lib/json'

export const KEYS = {
  session: (id: string) => `v2:s:${id}`,
  index: 'v2:index',
  run: 'v2:run',
  /**
   * The audit log of `/track clean` (issue #122), not per session: `/clear` and the session copies leave it alone. Before
   * issue #213 this one key held every run. This build still reads it, never writes it, and prunes it when it is old. It is
   * also the prefix of the run keys.
   */
  log: 'v2:log',
  /**
   * One run of `/track clean --yes` (issue #213): the time of the run, the JSON size of its entries and a tag (8 characters of
   * the session id, `-`, and a counter of the load). A run key is written once: no append reads another run's key, so no append
   * replaces the key of another session. One edge stays, on purpose: a new load of the same session restarts the counter, so
   * two runs of it with the same newest time (to the millisecond) and the same size would share a key.
   */
  logRun: (at: number, chars: number, tag: string) => `v2:log:${String(at).padStart(13, '0')}:${chars}:${tag}`,
} as const

/** A run key: the time, the size and, when the tag ends in `-<counter>`, the counter. */
const LOG_RUN = /^v2:log:(\d{13}):(\d+):.+?(?:-(\d+))?$/
/**
 * The parts of a run key (the read side of `KEYS.logRun`), or `undefined` for a key that is no run key: the old `v2:log`, or a
 * name made by hand under `v2:log:`. `seq` is the counter of the tag, or 0 when the tag has none.
 */
export const parseLogRun = (key: string): { at: number; chars: number; seq: number } | undefined => {
  const m = LOG_RUN.exec(key)
  return m ? { at: Number(m[1]), chars: Number(m[2]), seq: Number(m[3] ?? 0) } : undefined
}
/** The latest time a run key names: 13 digits. */
const MAX_RUN_TIME = 9_999_999_999_999
const isLogKey = (k: string): boolean => k === KEYS.log || k.startsWith(`${KEYS.log}:`)

/** How many entries of the audit log the store keeps: the newest. */
export const LOG_KEEP = 200

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
/**
 * A stored log entry that `logText` can print: a store fault or a later schema must not make `--log` throw on one bad entry.
 * The time must make a `Date`: a finite number past the range of a `Date` (`1e100`) still throws in `toISOString()`.
 */
const isEntry = (e: unknown): e is LogEntry =>
  isRecord(e) &&
  typeof e.at === 'number' &&
  Number.isFinite(new Date(e.at).getTime()) &&
  ['by', 'kind', 'id', 'action', 'outcome'].every(k => typeof e[k] === 'string')
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** The time of the newest entry, or `undefined` when there is none. */
const newestAt = (entries: readonly LogEntry[]): number | undefined =>
  entries.length === 0 ? undefined : entries.reduce((t, e) => Math.max(t, e.at), Number.NEGATIVE_INFINITY)

/** A log key with its rank: `at` is the time in a run key's name, or the newest entry of any other key. */
type RankedKey = { key: string; at: number; seq: number; chars: number; entries?: LogEntry[] }
/** What a walk does with a log key it cannot read: it tells the caller, who logs it or throws. */
type OnReadError = (key: string, e: unknown) => void
/** What a walk of the log keys saw. */
type Walk = {
  /** The newest `LOG_KEEP` entries, newest first. */
  entries: LogEntry[]
  /** The keys it read, newest first, with their sizes and the time of their newest entry (`undefined`: none prints). */
  read: { key: string; chars: number; newestAt: number | undefined }[]
  /** The keys it did not read. None of them can hold one of `entries`. */
  unread: string[]
  /** The time of the oldest of `entries` once the log is full, else minus infinity. */
  floor: number
}

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
  /** The size of each log key whose name holds none (the old `v2:log`). Learned from the store once per load, then kept. */
  private readonly logSizes = new Map<string, number>()
  /** Makes the tag of a run key unique in this load. */
  private logSeq = 0

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
      // The run record and the audit log sit in the store beside the copies, so both count against the bound.
      const run = (runChars ?? (await this.runBytes())) + (await this.logBytes())
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

  /**
   * The first start of a load that honours no pending end: whatever `v2:run` holds is an older process's. `stale` is
   * the record the start read. Deletes the key, so a later switch with no snapshot finds no run values to carry. The
   * start took a while since it read: a second process may have written its own end there. The key goes only if it
   * still holds `stale`.
   */
  async dropRun(stale: RunCopy): Promise<void> {
    if (stale.pendingEnd === undefined && stale.run === undefined) return
    const now = await this.loadRun()
    if (JSON.stringify(now) !== JSON.stringify(stale)) return
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

  /**
   * The audit log of `/track clean`: the entries of every run key and of the old `v2:log`, newest first by their time, at
   * most `LOG_KEEP`. It writes nothing. A key that cannot be read is logged and left out; a store that cannot list its keys
   * is logged and gives an empty log.
   */
  async readLog(): Promise<readonly LogEntry[]> {
    try {
      return (await this.walkLog((key, e) => this.d.log(`store: read of ${key} failed: ${reason(e)}`))).entries
    } catch (e) {
      this.d.log(`store: read of ${KEYS.log} failed: ${reason(e)}`)
      return []
    }
  }

  /**
   * Adds the entries of one run, given oldest first, under a key of their own. It lists the key names before it writes and
   * reads no value, so a run that another session adds meanwhile is never replaced. The run keeps the newest `LOG_KEEP`
   * entries and at most half of `maxBytes` (the oldest go first, and the newest stays even when it alone is over). Then it
   * prunes the old runs (`pruneLog`), only from the keys it listed. It writes at once and never rejects: a failed write or
   * prune is logged, and the next append tries again.
   */
  async appendLog(entries: readonly LogEntry[]): Promise<void> {
    if (entries.length === 0) return
    const { maxBytes } = this.d.limits()
    const run = [...entries].reverse().slice(0, LOG_KEEP)
    // The log never takes more than half of the bound, so the copies of the sessions keep the other half. The sessions make
    // room for the log at their next write (`write`).
    while (run.length > 1 && size(run as unknown as Json) > maxBytes / 2) run.pop()
    const runAt = Math.min(Math.max(Math.floor(Math.max(...run.map(e => e.at))) || 0, 0), MAX_RUN_TIME)
    const key = KEYS.logRun(runAt, size(run as unknown as Json), `${await this.sessionTag()}-${++this.logSeq}`)
    const listed = await this.listLogKeys() // before the write: the prune below deletes only from this list
    try {
      await this.d.store.set(key, run as unknown as Json)
    } catch (e) {
      this.d.log(`store: write of ${key} failed: ${reason(e)}`)
      return
    }
    await this.pruneLog(key, maxBytes, listed)
  }

  /** The log keys in the store, or the fault when it cannot list: the prune logs it after the write, as it logs any fault. */
  private async listLogKeys(): Promise<string[] | Error> {
    try {
      return (await this.d.store.keys()).filter(isLogKey)
    } catch (e) {
      return new Error(reason(e))
    }
  }

  /** The first 8 characters of the session id, for the tag of a run key. An id that cannot be read gives `nosess`: the run is still written. */
  private async sessionTag(): Promise<string> {
    try {
      return (await this.d.sessionId()).slice(0, 8)
    } catch (e) {
      this.d.log(`store: read of the session id for the log key failed: ${reason(e)}`)
      return 'nosess'
    }
  }

  /**
   * After an append: deletes the keys that hold none of the newest `LOG_KEEP` entries, then the oldest keys past half of
   * `maxBytes`. The key of this run (`own`) stays and is counted first, so the other keys, newest first, keep what is left of
   * the half (the log passes it only when this run alone does). `listed` is the list of keys that the run took before it
   * wrote, and the prune sees and deletes only those keys, so it never touches a run that another session wrote after that.
   * Two prunes then never delete each other's run: A deletes B only if B was written before A listed, B deletes A only if A
   * was written before B listed, and both cannot hold. Runs that write at the same moment can leave the log over half of
   * `maxBytes` until the next prune. A read that fails stops the prune before any delete. Never rejects.
   */
  private async pruneLog(own: string, maxBytes: number, listed: readonly string[] | Error): Promise<void> {
    try {
      if (listed instanceof Error) throw listed
      const { read, unread, floor } = await this.walkLog(
        (key, e) => {
          throw new Error(`read of ${key} failed: ${reason(e)}`) // a prune must not act on a partial view
        },
        new Set([...listed, own]),
      )
      const drop = new Set(unread.filter(key => key !== own))
      for (const k of read) if (k.key !== own && (k.newestAt === undefined || k.newestAt < floor)) drop.add(k.key)
      let chars = parseLogRun(own)?.chars ?? 0
      for (const k of read) {
        if (k.key === own || drop.has(k.key)) continue
        chars += k.chars
        if (chars > maxBytes / 2) drop.add(k.key)
      }
      for (const key of drop) {
        await this.d.store.delete(key)
        this.logSizes.delete(key)
      }
    } catch (e) {
      this.d.log(`store: prune of ${KEYS.log} failed: ${reason(e)}`)
    }
  }

  /**
   * Walks the log keys newest first and stops when no key left can hold one of the newest `LOG_KEEP` entries. A run key
   * ranks by the time in its name, so it is read only when it is needed. The old `v2:log` ranks by its newest entry, so it
   * is read first. A key that cannot be read goes to `onReadError`, and when that returns, the key counts as empty. It walks
   * the log keys that the store lists now, or only `keys` when the caller gives them (a prune).
   */
  private async walkLog(onReadError: OnReadError, keys?: Iterable<string>): Promise<Walk> {
    const ranked = await this.rankLogKeys(onReadError, keys)
    const merged: LogEntry[] = []
    const read: Walk['read'] = []
    for (let i = 0; i < ranked.length; i++) {
      const k = ranked[i] as RankedKey
      const entries = k.entries ?? (await this.readLogKey(k.key, onReadError))?.entries ?? []
      merged.push(...entries)
      merged.sort((a, b) => b.at - a.at) // stable: a tie in time keeps the order of the keys
      read.push({ key: k.key, chars: k.chars, newestAt: newestAt(entries) })
      const after = ranked[i + 1]
      if (after !== undefined && merged.length >= LOG_KEEP && (merged[LOG_KEEP - 1] as LogEntry).at >= after.at) break
    }
    const entries = merged.slice(0, LOG_KEEP)
    const floor = entries.length >= LOG_KEEP ? (entries[LOG_KEEP - 1] as LogEntry).at : Number.NEGATIVE_INFINITY
    return { entries, read, unread: ranked.slice(read.length).map(k => k.key), floor }
  }

  /**
   * Every log key, newest first. A run key ranks by the time in its name, and a tie by its counter, then by its name. The old
   * key (or a key under `v2:log:` with a name that is no run key) is read to rank it by its newest entry.
   */
  private async rankLogKeys(onReadError: OnReadError, keys?: Iterable<string>): Promise<RankedKey[]> {
    const ranked: RankedKey[] = []
    for (const key of keys ?? (await this.d.store.keys())) {
      if (!isLogKey(key)) continue
      const run = parseLogRun(key)
      if (run) {
        ranked.push({ key, ...run })
        continue
      }
      const got = await this.readLogKey(key, onReadError)
      if (got) this.logSizes.set(key, got.chars) // a key with no size in its name: learned here, kept for the flushes
      const entries = got?.entries ?? []
      ranked.push({ key, at: newestAt(entries) ?? Number.NEGATIVE_INFINITY, seq: 0, chars: got?.chars ?? 0, entries })
    }
    return ranked.sort((a, b) => b.at - a.at || b.seq - a.seq || (a.key < b.key ? 1 : -1))
  }

  /**
   * The printable entries of one log key and its stored size, or `undefined` when the read failed (`onReadError` was told
   * first). A key that holds no array has no entries.
   */
  private async readLogKey(
    key: string,
    onReadError: OnReadError,
  ): Promise<{ entries: LogEntry[]; chars: number } | undefined> {
    try {
      const raw = await this.d.store.get(key)
      return { entries: Array.isArray(raw) ? raw.filter(isEntry) : [], chars: size(raw) }
    } catch (e) {
      onReadError(key, e)
      return undefined
    }
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

  /**
   * The size of the audit log: a run key holds its size in its name, so one `keys()` call counts them with no read. A key
   * with no size in its name (the old `v2:log`) is read once per load. A failure is logged and counts as 0, and the sizes
   * already summed stay. A key that failed is tried again at the next write.
   */
  private async logBytes(): Promise<number> {
    let keys: string[]
    try {
      keys = await this.d.store.keys()
    } catch (e) {
      this.d.log(`store: list of ${KEYS.log} keys failed: ${reason(e)}`)
      return 0
    }
    let n = 0
    for (const k of keys) {
      if (!isLogKey(k)) continue
      const run = parseLogRun(k)
      if (run) {
        n += run.chars
        continue
      }
      if (!this.logSizes.has(k)) {
        try {
          this.logSizes.set(k, size(await this.d.store.get(k)))
        } catch (e) {
          this.d.log(`store: read of ${k} failed: ${reason(e)}`)
          continue
        }
      }
      n += this.logSizes.get(k) ?? 0
    }
    return n
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
