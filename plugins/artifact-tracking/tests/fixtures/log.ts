// The audit log as the tests read it from the fake store (issue #213). Each `--yes` run keeps its entries under its own
// key, `v2:log:<time>:<chars>:<tag>`; an older build kept them all under `v2:log`. A test that asks "what did the run
// log" reads the merged log here, and a test of the layout reads the keys. No `node:` import: the kit tests load it too.
// The kit world types its store as `Map<string, unknown>`, the fake ports as `Map<string, Json>`: both fit `Store`.
// The key name is parsed by `parseLogRun` of Persistence, not by a copy of its pattern. The rank rule below (time, counter,
// name) is the one of `readLog`; tests/persistence.test.ts checks that both order a seeded store the same way.

import { parseLogRun } from '../../core/infra/persistence'
import type { LogEntry } from '../../core/interfaces/clean'

type Store = ReadonlyMap<string, unknown>

/** Every key of the audit log: the old single key and the run keys. */
export const logKeys = (store: Store): string[] =>
  [...store.keys()].filter(k => k === 'v2:log' || k.startsWith('v2:log:'))

const entriesOf = (v: unknown): LogEntry[] => (Array.isArray(v) ? (v as LogEntry[]) : [])

/** The time and the counter of a key: a run key by its name, any other by its newest entry. */
const rank = (store: Store, key: string): [at: number, seq: number] => {
  const run = parseLogRun(key)
  if (run) return [run.at, run.seq]
  return [Math.max(...entriesOf(store.get(key)).map(e => e.at), Number.NEGATIVE_INFINITY), 0]
}

/** Every entry of every log key, newest first. A tie in time keeps the later run first, as `--log` does. */
export function storedLog(store: Store): LogEntry[] {
  const keys = logKeys(store).sort((a, b) => {
    const [aAt, aSeq] = rank(store, a)
    const [bAt, bSeq] = rank(store, b)
    return bAt - aAt || bSeq - aSeq || (a < b ? 1 : -1)
  })
  return keys.flatMap(k => entriesOf(store.get(k))).sort((a, b) => b.at - a.at)
}
