// The capture funnel: one row in, the refs and the Markdown mentions of its text merged into the item list. It holds the
// door rules of the four rows that carry text, the open check of short `#N` refs and the Jira site filter of tool output.
// Transitional (plan Task 11): layer L5 splits this into Capture and the kinds' `scan` and `accept`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L3 Task 11, D3 of the artifact-tracking spec.

import type { RowEvent } from '../../core/interfaces/events'
import { captureMentions, type FileSight } from '../../trackers/file/sighting'
import type { GhTool } from '../../trackers/github/gh-tool'
import type { GitHubRef, GitHubTarget, Ref, RepoRef, ScanMode, Source } from '../contracts'
import { keyOf } from '../model/keys'
import { commandArgs, extractRefs } from '../scan/refs'
import type { ItemStore } from './store'

/** D3: the person's own text. Never a machine, a notification or a coordinator. */
export const PERSON: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

/** What the funnel reads of the runtime. */
export type CaptureDeps = {
  /** undefined: not resolved yet. null: this session has no known repo. */
  repo(): RepoRef | null | undefined
  hosts(): readonly string[]
  ensureRepo(): Promise<void>
  /** The active Jira site: undefined, no acli runtime; null, none loaded; else the host. */
  site(): Promise<string | null | undefined>
  gh(): GhTool | undefined
  items: Pick<ItemStore, 'update' | 'trackRefs'>
  files(): FileSight | undefined
}

export function filterToolRefsForSite(refs: Ref[], site: string | null | undefined): Ref[] {
  if (!refs.some(r => r.category === 'jira')) return refs
  if (site === undefined) return refs
  if (site === null) return refs.filter(r => r.category !== 'jira')
  const active = site.toLowerCase()
  return refs.filter(r => r.category !== 'jira' || r.site.toLowerCase() === active)
}

function sameSessionRepo(
  repo: RepoRef | null | undefined,
  ref: Ref,
): ref is GitHubRef & { owner: string; repo: string; type: 'unknown' } {
  if (ref.category !== 'github' || ref.short !== true || ref.type !== 'unknown' || !ref.owner || !ref.repo || !repo)
    return false
  return (
    ref.host.toLowerCase() === repo.host.toLowerCase() &&
    ref.owner.toLowerCase() === repo.owner.toLowerCase() &&
    ref.repo.toLowerCase() === repo.repo.toLowerCase()
  )
}

/**
 * A short `#N` of the session repo counts only when the item exists and is open. Without `gh` none of them counts.
 * One pre-check call refreshes the candidates and reads their state.
 */
export async function keepOpenSessionShortRefs(d: Pick<CaptureDeps, 'repo' | 'gh'>, refs: Ref[]): Promise<Ref[]> {
  const repo = d.repo()
  const probe = d.gh()
  if (!probe) return refs.filter(ref => !sameSessionRepo(repo, ref))
  const candidates = refs.filter((ref): ref is GitHubRef & { owner: string; repo: string; type: 'unknown' } =>
    sameSessionRepo(repo, ref),
  )
  if (candidates.length === 0) return refs
  const targets: GitHubTarget[] = candidates.map(ref => ({
    key: keyOf(ref),
    host: ref.host,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    type: ref.type,
  }))
  await probe.refreshItems(targets)
  // GhTool sets either `error` or a normalized lower-case `state` for each queried item.
  const keep = new Set(targets.filter(t => t.error === undefined && t.state === 'open').map(t => t.key))
  return refs.filter(ref => !sameSessionRepo(repo, ref) || keep.has(keyOf(ref)))
}

export class Capture {
  constructor(private readonly d: CaptureDeps) {}

  /** One row. Only the doors that carry the person's or Claude's text count; the rules are today's four hooks. */
  async row(ev: RowEvent): Promise<void> {
    if (!ev.hasMessage) return
    switch (ev.door) {
      case 'prompt':
        // The person's typed prompt. Machines and notifications are not the person's text (D3).
        if (PERSON.has(ev.origin) && !ev.isMeta && ev.agentId === undefined) await this.text(ev.text, 'full', 'prompt')
        return
      case 'command':
        // The person's slash command. Only the arguments count. Our own `/track` output has origin `engine`.
        if (ev.origin === 'composer') await this.text(commandArgs(ev.text), 'full', 'prompt')
        return
      case 'response':
        // Claude's text, also from subagents.
        await this.text(ev.text, 'full', 'response')
        return
      case 'tool-result':
        // Tool output. Explicit GitHub and Jira URLs only.
        await this.text(ev.text, 'urls-only', 'tool')
        return
    }
  }

  /** Scans text and merges the refs into the session list. A file fault must not stop the refs. */
  async text(text: string, mode: ScanMode, source: Source): Promise<void> {
    if (text === '') return
    const { d } = this
    await d.ensureRepo()
    const sight = d.files()
    if (mode === 'full' && sight) await captureMentions(sight, d.items, text, source).catch(() => {})
    let refs = extractRefs(text, {
      mode,
      defaultRepo: d.repo() ?? null,
      githubHosts: d.hosts(),
      strictShortRefs: mode === 'full',
    })
    if (mode === 'full') refs = await keepOpenSessionShortRefs(d, refs)
    if (source === 'tool' && mode === 'urls-only') refs = filterToolRefsForSite(refs, await d.site())
    await d.items.trackRefs(refs, source)
  }
}
