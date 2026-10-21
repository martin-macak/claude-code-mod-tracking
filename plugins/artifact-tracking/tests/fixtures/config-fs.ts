// An in-memory `ConfigFs` for the ConfigManager tests. Files are a Map, each with an mtime that a write or an `edit` bumps,
// so the signature `mtimeMs:size` changes the way a real file's does. `calls` records every attempt, denied ones too.
// `writes` records the successful writes only. A deny switch rejects its op with an Error of the given message.
// `stat` resolves null for a refusal, as the engine's stat does.
// `fakeConfig` is a `ConfigService` with no fs: the views come from `normaliseDoc` over a file object the test sets.
// Plan: L4 Tasks 4 and 5.
import { type DocSpec, normaliseDoc } from '../../core/infra/config-file'
import type { ConfigFs, ConfigService } from '../../core/interfaces/config'
import type { JsonObject } from '../../core/interfaces/items'
import type { FsStat } from '../../core/interfaces/ports'
import { capProblems } from '../../core/lib/problems'

type Op = 'read' | 'write' | 'exists' | 'stat'

export interface FakeConfigFs {
  readonly fs: ConfigFs
  readonly files: Map<string, string>
  /** `'stat <path>'`, `'read <path>'`, `'write <path>'`, `'exists <path>'`, in call order. */
  readonly calls: string[]
  /** How many `read` calls got past the deny switch. */
  readonly reads: number
  readonly writes: { path: string; text: string }[]
  /** Reject that op with this message (`stat` resolves null). */
  readonly deny: Partial<Record<Op, string>>
  /** Sets the text and bumps the mtime, as an editor save does. */
  edit(path: string, text: string): void
  /** The next read returns `text`, then the mtime moves: a writer was in the middle of its write. */
  tearNext(text: string): void
}

export function fakeConfigFs(seed: Record<string, string> = {}): FakeConfigFs {
  const files = new Map(Object.entries(seed))
  const mtimes = new Map<string, number>()
  let clock = 1_000
  let torn: string | undefined
  let reads = 0
  const touch = (path: string): void => {
    clock += 1
    mtimes.set(path, clock)
  }
  for (const path of files.keys()) touch(path)
  const calls: string[] = []
  const writes: { path: string; text: string }[] = []
  const deny: Partial<Record<Op, string>> = {}
  const refuse = (op: Op, path: string): void => {
    calls.push(`${op} ${path}`)
    const message = deny[op]
    if (message !== undefined) throw new Error(message)
  }

  const fs: ConfigFs = {
    async stat(path): Promise<FsStat | null> {
      calls.push(`stat ${path}`)
      const text = files.get(path)
      if (deny.stat !== undefined || text === undefined) return null
      return { kind: 'file', size: text.length, mtimeMs: mtimes.get(path) ?? 0, isLink: false }
    },
    async exists(path) {
      refuse('exists', path)
      return files.has(path)
    },
    async read(path) {
      refuse('read', path)
      reads += 1
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      if (torn === undefined) return text
      const part = torn
      torn = undefined
      touch(path)
      return part
    },
    async write(path, text) {
      refuse('write', path)
      files.set(path, text)
      touch(path)
      writes.push({ path, text })
    },
  }
  return {
    fs,
    files,
    calls,
    get reads() {
      return reads
    },
    writes,
    deny,
    edit(path, text) {
      files.set(path, text)
      touch(path)
    },
    tearNext(text) {
      torn = text
    },
  }
}

/** A `ConfigService` with no fs. `set` changes the views at once; the next `refresh()` answers true once. */
export type FakeConfig = ConfigService & {
  set(file: JsonObject): void
  /** `'refresh'` and `'reconcile'`, in call order. */
  readonly calls: string[]
  /** The `stored` argument of every `reconcile` call. */
  readonly reconciled: ReadonlyMap<string, JsonObject>[]
}

export function fakeConfig(
  o: { specs?: readonly DocSpec[]; file?: JsonObject; path?: string; problems?: readonly string[] } = {},
): FakeConfig {
  const specs = o.specs ?? []
  let doc = normaliseDoc(o.file ?? {}, specs)
  let dirty = false
  const calls: string[] = []
  const reconciled: ReadonlyMap<string, JsonObject>[] = []
  return {
    calls,
    reconciled,
    set(file) {
      doc = normaliseDoc(file, specs)
      dirty = true
    },
    global: () => doc.global,
    slice: id => doc.slices.get(id) ?? Object.freeze({}),
    enabled(id) {
      return this.slice(id).enabled !== false
    },
    // The cap of the real manager (issue #144): the first 50 and one count line.
    problems: () => capProblems([...(o.problems ?? []), ...doc.problems]).list,
    moreProblems: () => capProblems([...(o.problems ?? []), ...doc.problems]).more,
    path: () => o.path,
    async refresh() {
      calls.push('refresh')
      const changed = dirty
      dirty = false
      return changed
    },
    async reconcile(stored) {
      calls.push('reconcile')
      reconciled.push(stored)
    },
  }
}
