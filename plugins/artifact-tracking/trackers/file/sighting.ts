// Markdown file sightings (issue #28): where a path lands, which sighting it is, and how it joins the item list.
// Moved out of hooks/register.tsx. Both the item runtime (mentions in prompts and replies) and, from layer step 12, the
// file tracker (Write, Edit and Read results) use it. It takes a small dependency object, so a tracker context fits.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 11.

import type { ItemStorePort, Json } from '../../core/interfaces/items'
import type { EnvName, FsStat } from '../../core/interfaces/ports'
import type { FactsPort } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'
import type { AgentProof, FileActivity, FileRecord, ItemRecord, Sighting, Source } from '../../hooks/contracts'
import { mergeFiles, recordFromFile } from '../../hooks/model/registry'
import { type FileTouch, type IgnoreContext, isIgnored, mdCandidates, normalizePath, resolvePath } from './files'

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

/** One sighting service per load: the environment is read once, because every Write, Edit, Read and mention needs it. */
export class FileSight {
  private env: Promise<FileEnv> | undefined

  constructor(private readonly d: SightDeps) {}

  /** A subagent's relative path joins its spawn cwd (A6); everything else joins the session cwd. */
  async ctxFor(agentId?: string): Promise<FileCtx> {
    this.env ??= readFileEnv(this.d)
    const agents = this.d.facts.read<Json>('auto.agents') as unknown as AgentProof[] | undefined
    const spawn = agentId === undefined ? undefined : agents?.find(a => a.id === agentId)?.cwd
    const root = this.d.facts.read<Json>('auto.root')
    const top = isRecord(root) && typeof root.cwd === 'string' ? root.cwd : undefined
    return { ...(await this.env), cwd: spawn ?? (await this.d.session.cwd()), ...(top ? { root: top } : {}) }
  }

  /** Where an absolute path lands: the real path from one stat, else the path itself. */
  private async landed(path: string): Promise<{ path: string; exists: boolean }> {
    const st = await this.d.fs.stat(path, { resolve: true })
    if (!st) return { path, exists: false }
    return { path: st.realPath ? normalizePath(st.realPath) : path, exists: st.kind === 'file' }
  }

  /** One sighting of a Markdown file. null: an ignored path, or a mention of a file that is not there. */
  async sighting(
    ctx: FileCtx,
    spelled: string,
    kind: FileActivity,
    bySubagent: boolean,
    s: Sighting,
  ): Promise<FileRecord | null> {
    const label = resolvePath(spelled, ctx.cwd, ctx.home)
    if (label === null || isIgnored(label, ctx)) return null
    const hit = await this.landed(label)
    if (kind === 'mentioned' && !hit.exists) return null
    return recordFromFile({ path: hit.path, label, kind, bySubagent }, s)
  }

  /** `.md` paths that a prompt or reply names and that exist: one `mentioned` sighting each (R8). */
  async mentionRecords(ctx: FileCtx, text: string, s: Sighting): Promise<FileRecord[]> {
    const recs: FileRecord[] = []
    for (const name of mdCandidates(text)) {
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

/** Drops the views of files that no earlier sighting tracks: a Read alone never adds a row. */
export function withoutLoneViews(list: readonly ItemRecord[], recs: readonly FileRecord[]): FileRecord[] {
  const known = new Set(list.map(i => i.key))
  return recs.filter(r => {
    if (r.views > 0) return known.has(r.key)
    known.add(r.key)
    return true
  })
}

/** Merges file sightings into the list. A dismissed key never comes back, and a list that would not change is not written. */
export async function addFiles(items: Pick<ItemStorePort, 'update'>, recs: readonly FileRecord[]): Promise<void> {
  await items.update((stored, dismissed) => {
    const list = stored as unknown as ItemRecord[]
    const wanted = withoutLoneViews(
      list,
      recs.filter(r => !dismissed.has(r.key)),
    )
    return wanted.length === 0 ? stored : (mergeFiles(list, wanted) as unknown as typeof stored)
  })
}

/** A Write, Edit or Read result: one sighting of the file it touched. */
export async function captureFileTouch(
  sight: FileSight,
  items: Pick<ItemStorePort, 'update'>,
  t: FileTouch,
  agentId: string | undefined,
): Promise<void> {
  const ctx = await sight.ctxFor(agentId)
  const rec = await sight.sighting(ctx, t.spelled, t.kind, agentId !== undefined, { source: 'tool', at: sight.at() })
  if (rec) await addFiles(items, [rec])
}

/** The `.md` files a prompt or reply names. Most rows name none: no read then. */
export async function captureMentions(
  sight: FileSight,
  items: Pick<ItemStorePort, 'update'>,
  text: string,
  source: Source,
): Promise<void> {
  if (mdCandidates(text).length === 0) return
  const recs = await sight.mentionRecords(await sight.ctxFor(), text, { source, at: sight.at() })
  if (recs.length > 0) await addFiles(items, recs)
}
