// ConfigManager: the one reader and the only writer of the config file. It reads through a four-call fs port, caches
// the parse by the signature `mtimeMs:size`, survives a torn read, and writes only the first-run defaults and missing
// keys, once per load. It never changes a user value and never touches a file it could not parse or stat.
// The file format lives in `config-file.ts`, the path rule in `config-path.ts`. Names no tracker: only `{ id, config }`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 4 (decisions C7, C10, C16, C17).

import type { ConfigFs, ConfigService, GlobalConfig, Migration, MoreProblems } from '../interfaces/config'
import type { JsonObject } from '../interfaces/items'
import type { EnvName, FsStat } from '../interfaces/ports'
import { capProblems } from '../lib/problems'
import {
  CONFIG_VERSION,
  type DocSpec,
  isObject,
  mergeMissing,
  type NormalisedDoc,
  normaliseDoc,
  parseConfig,
  renderConfig,
  signatureOf,
} from './config-file'
import { resolveConfigPath, resolveDebugLog } from './config-path'

/** The upgrades from an older file version. Version 1 has none. */
export const MIGRATIONS: readonly Migration[] = []

export interface ConfigDeps {
  fs: ConfigFs
  env: { get(name: EnvName): Promise<string | undefined> }
  /** In `TRACKERS` order. A `Tracker` fits. */
  specs: readonly DocSpec[]
  log(line: string): void
  /** The file version the mod knows. Default `CONFIG_VERSION`. */
  version?: number
  /** Default `MIGRATIONS`. */
  migrations?: readonly Migration[]
}

/** What the last good read left. `sig` is null for a file that does not exist. */
interface Snap {
  readonly sig: string | null
  readonly text?: string
  /** The object to complete: the file as read, or its migrated copy. */
  readonly base?: JsonObject
  /** The file's version, set only when `base` is a migrated copy. */
  readonly from?: number
}

const EMPTY: Readonly<JsonObject> = Object.freeze({})
/** The engine words a refusal as `<plugin>: <call>: <reason>`. The problem line quotes the reason only. */
const ENGINE_PREFIX = /^[\w-]+: \$\.fs\.\w+: /
const why = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(ENGINE_PREFIX, '').replace(/\.$/, '')

export class ConfigManager implements ConfigService {
  private readonly known: number
  private readonly chain: readonly Migration[]
  /** The views with no file. */
  private readonly fresh: NormalisedDoc
  private doc: NormalisedDoc
  private pathStep?: Promise<string | undefined>
  private where?: string
  /** The default place of the debug log, named by the count line of the problems. Undefined when the mod has none. */
  private debugLog?: string
  private pathProblems: readonly string[] = []
  private snap?: Snap
  /** F1 or F2: the mod cannot tell whether the file exists. Re-checked on every refresh. */
  private blocked?: string
  /** F3, F5 or F6, with the signature that failed. Not read again until the signature moves. */
  private failed?: { sig: string; text: string }
  /** F4 and F9 last for the load. */
  private f4?: string
  private f9?: string
  private flight?: Promise<boolean>
  private reconciled = false
  private readonly logged = new Set<string>()

  constructor(private readonly d: ConfigDeps) {
    this.known = d.version ?? CONFIG_VERSION
    this.chain = d.migrations ?? MIGRATIONS
    this.fresh = this.doc = normaliseDoc({}, d.specs, this.known)
  }

  global(): Readonly<GlobalConfig> {
    return this.doc.global
  }

  slice(id: string): Readonly<JsonObject> {
    return this.doc.slices.get(id) ?? EMPTY
  }

  enabled(id: string): boolean {
    return this.slice(id).enabled !== false
  }

  path(): string | undefined {
    return this.where
  }

  /**
   * What the mod shows: the first `MAX_PROBLEMS` of the file's problems, then one count line when more exist (issue #144).
   * The log keeps every problem (`report`).
   */
  problems(): readonly string[] {
    return this.capped().list
  }

  /** What `problems()` leaves out: the count and the count line, which is the last entry of `problems()`. */
  moreProblems(): MoreProblems | undefined {
    return this.capped().more
  }

  private capped(): ReturnType<typeof capProblems> {
    return capProblems(this.allProblems(), this.debugLog)
  }

  /**
   * Every problem, in the Copy table order: path, file state, the upgrade copy, a refused write, then the values. The
   * problems of the file state and the write are at most one each, so they come before the values, which can number in the
   * thousands and fill the 50 that the mod shows (issue #144). Only the log sees what the cap cuts.
   */
  private allProblems(): readonly string[] {
    const own = [this.blocked, this.failed?.text, this.f9, this.f4].filter((p): p is string => p !== undefined)
    return [...this.pathProblems, ...own, ...this.doc.problems]
  }

  /** One run at a time: callers that come while it runs share it. */
  refresh(): Promise<boolean> {
    this.flight ??= this.check().finally(() => {
      this.flight = undefined
    })
    return this.flight
  }

  async reconcile(stored: ReadonlyMap<string, JsonObject>): Promise<void> {
    if (this.reconciled) return
    this.reconciled = true
    const path = await this.locate()
    if (path === undefined || this.halted()) return
    const sigOf = async (): Promise<string | null> => {
      const st = await this.stat(path)
      return st === null ? null : signatureOf(st)
    }
    if (this.snap === undefined || this.snap.sig !== (await sigOf())) {
      // The file moved since the last read, or was never read: read it first.
      await this.refresh()
      if (this.halted()) return
      // A save in flight leaves the old snapshot. Writing from it would replace the user's new text: wait for the next load.
      if (this.snap?.sig !== (await sigOf())) return
    }
    const snap = this.snap
    if (snap === undefined) return
    const trackers: Record<string, JsonObject> = {}
    for (const { id } of this.d.specs) {
      const result = stored.get(id)
      if (result !== undefined) trackers[id] = result
    }
    const wanted: JsonObject = { version: this.known, global: this.doc.global as unknown as JsonObject, trackers }
    const base = snap.base ?? {}
    const merged = mergeMissing(base, wanted)
    // The file is the user's: it is written only to add a key (or to upgrade it). A complete file stays as it is, with its
    // indent, its final newline and its key order. `mergeMissing` keeps every key of `base` in place and appends the
    // added ones, so an equal text means that nothing was added. A missing file has the empty base and always gains.
    if (snap.from === undefined && JSON.stringify(merged) === JSON.stringify(base)) return
    if (snap.from !== undefined && snap.text !== undefined) {
      try {
        await this.d.fs.write(`${path}.v${snap.from}.bak`, snap.text)
      } catch (e) {
        this.f9 = `The mod cannot save a copy of the file before the upgrade: ${why(e)}. It does not change the file.`
        return this.report()
      }
    }
    const next = renderConfig(merged)
    try {
      await this.d.fs.write(path, next)
    } catch (e) {
      this.f4 = `The mod cannot write the file: ${why(e)}. It tries again at the next start.`
      return this.report()
    }
    await this.refresh()
  }

  /**
   * True when the mod must not write: it cannot read or stat the file, the last read failed, or the file is not its
   * version. The `failed` clause is an early exit that spares the stats below. It is also a second guard: `failed` is set
   * only by a read at a signature that differs from the snapshot's, so the signature check in `reconcile` stops the
   * write too. Keep both.
   */
  private halted(): boolean {
    return this.blocked !== undefined || this.failed !== undefined || this.doc.readOnly
  }

  private locate(): Promise<string | undefined> {
    this.pathStep ??= Promise.all([resolveConfigPath(this.d.env), resolveDebugLog(this.d.env)]).then(([r, log]) => {
      this.pathProblems = r.problems
      this.where = r.path
      this.debugLog = log
      return r.path
    })
    return this.pathStep
  }

  /** The engine's stat gives null for a refusal. A rejection counts the same. */
  private async stat(path: string): Promise<FsStat | null> {
    try {
      return await this.d.fs.stat(path)
    } catch {
      return null
    }
  }

  private async check(): Promise<boolean> {
    const before = this.views()
    const path = await this.locate()
    if (path !== undefined) await this.read(path)
    this.report()
    return this.views() !== before
  }

  /** The values and the problems a reader sees, as text. Two equal texts mean no change for a reader. */
  private views(): string {
    return JSON.stringify([this.doc.global, [...this.doc.slices], this.problems()])
  }

  private async read(path: string): Promise<void> {
    const st = await this.stat(path)
    if (st === null) return this.absent(path)
    this.blocked = undefined
    const sig = signatureOf(st)
    if (sig === this.snap?.sig || sig === this.failed?.sig) return
    let text: string
    let parsed: ReturnType<typeof parseConfig>
    try {
      text = await this.d.fs.read(path)
      parsed = parseConfig(text)
      if (!parsed.ok) {
        // A parse error is transient first (C7). A moved signature is a write in flight: wait for the next check.
        const again = await this.stat(path)
        if (again === null || signatureOf(again) !== sig) {
          this.failed = undefined
          return
        }
        text = await this.d.fs.read(path)
        parsed = parseConfig(text)
      }
    } catch (e) {
      this.failed = { sig, text: `The mod cannot read the file: ${why(e)}. It keeps the last good values.` }
      return
    }
    if (!parsed.ok) {
      const note = 'The mod keeps the last good values and does not change the file.'
      this.failed = { sig, text: `The file is not valid JSON: ${parsed.error}. ${note}` }
    } else if (!isObject(parsed.value)) {
      this.failed = {
        sig,
        text: 'The file must hold one JSON object. The mod keeps the last good values and does not change the file.',
      }
    } else {
      this.failed = undefined
      this.adopt(sig, text, parsed.value)
    }
  }

  /** `stat` gave null: the file is missing (the defaults), or the mod cannot tell (F1, F2: the defaults, no write). */
  private async absent(path: string): Promise<void> {
    let exists = false
    this.blocked = undefined
    try {
      exists = await this.d.fs.exists(path)
      if (exists)
        this.blocked = 'The mod cannot read the status of the file. It uses the defaults and does not write the file.'
    } catch (e) {
      this.blocked = `The mod cannot check the file: ${why(e)}. It uses the defaults and does not write the file.`
    }
    this.failed = undefined
    this.doc = this.fresh
    this.snap = this.blocked === undefined ? { sig: null } : undefined
  }

  /** Takes a good read: migrates a copy of an older file when a chain leads to the known version, then normalises. */
  private adopt(sig: string, text: string, raw: JsonObject): void {
    const v = raw.version
    const from = typeof v === 'number' && Number.isInteger(v) && v >= 1 && v < this.known ? v : undefined
    const migrated = from === undefined ? undefined : this.migrate(raw, from)
    const base = migrated ?? raw
    this.snap = { sig, text, base, from: migrated === undefined ? undefined : from }
    this.doc = normaliseDoc(base, this.d.specs, this.known)
  }

  /** The upgraded copy, or undefined when no chain of steps leads from `from` to the known version. */
  private migrate(raw: JsonObject, from: number): JsonObject | undefined {
    try {
      let cur: JsonObject = structuredClone(raw)
      let at = from
      for (let left = this.chain.length; at < this.known && left > 0; left--) {
        const step = this.chain.find(m => m.from === at)
        if (step === undefined) return undefined
        cur = { ...step.up(cur), version: step.to }
        at = step.to
      }
      return at === this.known ? cur : undefined
    } catch {
      return undefined
    }
  }

  /** Logs each distinct problem once per load: all of them, past the cap of what the mod shows. */
  private report(): void {
    for (const p of this.allProblems()) {
      if (this.logged.has(p)) continue
      this.logged.add(p)
      this.d.log(`config: ${p}`)
    }
  }
}
