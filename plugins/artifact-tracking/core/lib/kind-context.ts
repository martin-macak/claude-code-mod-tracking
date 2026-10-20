// A `KindContext` for a pure scan: what the kinds read of a text (the source, the time, the mode, a config slice, some
// facts), with inert ports for the rest. A caller that has no live tracker context uses it: the `/track prio` lookup, a
// PR body, the old `extractRefs` binding, a unit test. Plan: L5 Task 5.

import type { Json, JsonObject, KindContext, KindReason, ScanMode } from '../interfaces/items'
import { GLOBAL_DEFAULTS } from './global-config'

export type ScanContextOptions = {
  mode: ScanMode
  /** `capture`: conversation text, strict short refs. `lookup`: `/track prio`, a PR body. */
  purpose: 'capture' | 'lookup'
  source?: string
  now?: number
  /** What `ctx.facts.read` answers, by name. */
  facts?: Readonly<Record<string, Json | undefined>>
  /** What `ctx.config.slice()` answers: the config of the tracker that owns the kind being asked. */
  slice?: JsonObject
  /** The reasons of the kind that passed the check (`ctx.kindReasons`). Default: none. */
  kindReasons?: readonly KindReason[]
}

export function scanContext(o: ScanContextOptions): KindContext {
  const facts = o.facts ?? {}
  return {
    now: o.now ?? 0,
    source: o.source ?? 'prompt',
    mode: o.mode,
    purpose: o.purpose,
    config: { slice: () => o.slice ?? {}, global: () => GLOBAL_DEFAULTS },
    kindReasons: o.kindReasons ?? [],
    facts: { read: <T extends Json>(name: string) => facts[name] as T | undefined },
    tools: {
      handle: () => undefined,
      run: async () => {
        throw new Error('a scan runs no tool')
      },
    },
    fs: { stat: async () => null, exists: async () => false },
    env: { get: async () => undefined, settings: async () => undefined, agents: async () => [] },
    session: { id: async () => '', cwd: async () => '', repo: async () => null, root: () => undefined },
    clock: { wall: () => o.now ?? 0 },
    log: () => {},
  }
}
