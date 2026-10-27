// File sightings (issues #28 and #57): where a path lands and which sighting it is. The part of `sighting.ts` that a
// kind needs, with no join to the item list, so the file kind can import it without a cycle through the registry.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 11, L5 Task 8.

import type { Json } from '../../core/interfaces/items'
import type { EnvName, FsStat } from '../../core/interfaces/ports'
import type { FactsPort } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'
import { normalizePath } from '../../core/lib/paths'
import { rootOf } from './facts'
import { type IgnoreContext, isIgnored, pathCandidates, resolvePath } from './files'
import { fileRecord } from './kind'
import type { FileActivity, FileRecord, Sighting } from './types'

/** What a sighting reads of an agent of the `auto.agents` fact: its id and the cwd it was spawned in. */
type SpawnProof = { id: string; cwd?: string }

/** What a sighting reads of the world. A `TrackerContext` and a `HostContext` both fit. */
export type SightDeps = {
  env: { get(name: EnvName): Promise<string | undefined>; settings(): Promise<Json | undefined> }
  fs: { stat(path: string, opts?: { resolve?: boolean }): Promise<FsStat | null> }
  session: { cwd(): Promise<string> }
  facts: Pick<FactsPort, 'read'>
  clock: { wall(): number }
}

export type FileEnv = { home?: string; configDir?: string; memoryDir?: string }

/** What a file sighting needs: the cwd of a relative path, HOME for `~/`, and the ignore rule's root and config dir. */
export type FileCtx = IgnoreContext & { cwd: string; home?: string }

/**
 * HOME, the Claude config dir (`CLAUDE_CONFIG_DIR`, else `$HOME/.claude`) and the `autoMemoryDirectory` setting.
 * The setting is newer than the pinned types, so it is read as plain data. Unset or unreadable: absent.
 */
async function readFileEnv(d: Pick<SightDeps, 'env'>): Promise<FileEnv> {
  const home = await d.env.get('HOME').catch(() => undefined)
  const dir = await d.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const configDir = dir ? normalizePath(dir) : home ? normalizePath(`${home}/.claude`) : undefined
  const settings = await d.env.settings().catch(() => undefined)
  const mem = isRecord(settings) && typeof settings.autoMemoryDirectory === 'string' ? settings.autoMemoryDirectory : ''
  const memoryDir = mem ? resolvePath(mem, configDir ?? '/', home) : null
  return { ...(home ? { home } : {}), ...(configDir ? { configDir } : {}), ...(memoryDir ? { memoryDir } : {}) }
}

/** The environment of a load, read once and shared by every sighting service of that load. */
export type SightCache = { env?: Promise<FileEnv> }

/**
 * One sighting service. The environment is read once per cache, because every Write, Edit, Read and mention needs it.
 * The item runtime keeps one service for its load. The file tracker builds one per dispatch over a shared cache.
 */
export class FileSight {
  constructor(
    private readonly d: SightDeps,
    private readonly cache: SightCache = {},
  ) {}

  /** A subagent's relative path joins its spawn cwd (A6); everything else joins the session cwd. */
  async ctxFor(agentId?: string): Promise<FileCtx> {
    this.cache.env ??= readFileEnv(this.d)
    const agents = this.d.facts.read<Json>('auto.agents') as unknown as SpawnProof[] | undefined
    const spawn = agentId === undefined ? undefined : agents?.find(a => a.id === agentId)?.cwd
    const { cwd: top } = rootOf(this.d.facts)
    return { ...(await this.cache.env), cwd: spawn ?? (await this.d.session.cwd()), ...(top ? { root: top } : {}) }
  }

  /**
   * Where an absolute path lands: the real path from one stat, else the path itself. A file that is gone (a Bash delete) has no
   * real path of its own, so its folder lands instead and the name joins it: the delete then marks the row that an earlier
   * Write, Edit or Read keyed by the real path, also when the folder is a symlink (`/tmp` to `/private/tmp`). A mention of a
   * file that is gone adds no row, so it costs the one stat of the file and no more (`folder` false).
   */
  private async landed(path: string, folder: boolean): Promise<{ path: string; exists: boolean }> {
    const st = await this.d.fs.stat(path, { resolve: true })
    if (st) return { path: st.realPath ? normalizePath(st.realPath) : path, exists: st.kind === 'file' }
    const cut = path.lastIndexOf('/')
    const dir = folder && cut > 0 ? await this.d.fs.stat(path.slice(0, cut), { resolve: true }) : null
    return { path: dir?.realPath ? normalizePath(`${dir.realPath}${path.slice(cut)}`) : path, exists: false }
  }

  /** One sighting of a file. null: an ignored path, or a mention of a file that is not there. */
  async sighting(
    ctx: FileCtx,
    spelled: string,
    kind: FileActivity,
    bySubagent: boolean,
    s: Sighting,
  ): Promise<FileRecord | null> {
    const label = resolvePath(spelled, ctx.cwd, ctx.home)
    if (label === null || isIgnored(label, ctx)) return null
    const hit = await this.landed(label, kind !== 'mentioned')
    if (kind === 'mentioned' && !hit.exists) return null
    return fileRecord({ path: hit.path, label, kind, bySubagent }, s)
  }

  /**
   * Paths that a prompt or reply names and that exist: one `mentioned` sighting each (R8). At most `max` paths
   * are looked at (`maxMentionsPerRow`).
   */
  async mentionRecords(ctx: FileCtx, text: string, s: Sighting, max?: number): Promise<FileRecord[]> {
    const recs: FileRecord[] = []
    for (const name of pathCandidates(text, max)) {
      const rec = await this.sighting(ctx, name, 'mentioned', false, s)
      if (rec) recs.push(rec)
    }
    return recs
  }

  /** The time stamp of a sighting. */
  at(): number {
    return this.d.clock.wall()
  }
}
