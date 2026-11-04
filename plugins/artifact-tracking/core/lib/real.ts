// Canonical paths for the trackers (issues #255, #344). On macOS `/tmp` is `/private/tmp` and `/var` is `/private/var`. Git lists
// the canonical path of a worktree, and an agent can name the same folder by an alias. The match rules are pure and sync, so
// the round resolves each path once, with an async call, into a cache. The draw path only reads the cache.

import { normPath, type Real } from './porcelain'

/** Path (no trailing slash) to its canonical path and the time it was read. A path that could not be resolved has no entry. */
export type RealCache = Map<string, { real: string; at: number }>

/** Entries that one cache keeps. A longer cache starts again, so a long run does not grow it without end. */
export const REAL_CAP = 512

/** How long an entry holds. After that the path is read again, so a link that was retargeted does not keep its old match. */
export const REAL_TTL_MS = 60_000

/** The sync lookup over a cache. A path with no entry is its own canonical path. */
export const realOf =
  (cache: ReadonlyMap<string, { real: string }>): Real =>
  path => {
    const p = normPath(path)
    return cache.get(p)?.real ?? p
  }

/**
 * Resolves each path that the cache does not know, or knows for longer than `REAL_TTL_MS`, and gives the canonical paths of
 * every requested path for this round. `resolve` gives the canonical path. When it gives nothing or throws (the path is
 * missing or refused) the path leaves the cache and is asked again at the next round, as a worktree can appear. The cap
 * bounds only what the cache keeps between rounds (`REAL_CAP` entries), never what this round resolves. Never rejects.
 */
export async function resolveReal(
  resolve: (path: string) => Promise<string | undefined>,
  cache: RealCache,
  paths: Iterable<string>,
  at: number,
): Promise<ReadonlyMap<string, { real: string }>> {
  const wanted = [...new Set([...paths].map(normPath))].filter(p => p !== '')
  const todo = wanted.filter(p => {
    const e = cache.get(p)
    return e === undefined || at - e.at >= REAL_TTL_MS
  })
  const round = new Map<string, { real: string; at: number }>()
  for (const p of wanted) {
    const e = cache.get(p)
    if (e !== undefined) round.set(p, e)
  }
  await Promise.all(
    todo.map(async p => {
      try {
        const r = await resolve(p)
        if (typeof r === 'string' && r !== '') round.set(p, { real: normPath(r), at })
        else round.delete(p)
      } catch {
        // A missing path stays as it is: the plain spelling still matches.
        round.delete(p)
      }
    }),
  )
  for (const p of todo) cache.delete(p)
  if (cache.size + todo.length > REAL_CAP) cache.clear()
  for (const p of todo) {
    const e = round.get(p)
    if (e !== undefined && cache.size < REAL_CAP) cache.set(p, e)
  }
  return round
}

/** One cache with its resolver: `resolve(paths)` reads what is new or old, then gives the sync lookup. Never rejects. */
export type RealResolver = { resolve: (paths: Iterable<string>) => Promise<Real> }

export function makeRealResolver(
  stat: (path: string) => Promise<string | undefined>,
  now: () => number = Date.now,
): RealResolver {
  const cache: RealCache = new Map()
  return {
    resolve: async paths => {
      return realOf(await resolveReal(stat, cache, paths, now()))
    },
  }
}
