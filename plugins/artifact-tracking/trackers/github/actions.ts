// The row keys of the github tracker (issue #50): `resolve` hands Claude a ready prompt for a PR that conflicts, and `files`
// lists the files that conflict. Both are off, not hidden, unless the row is an open PR that the lane found, that GitHub
// reports CONFLICTING and that `gh` can vouch for. The mod never rebases, merges or pushes: `resolve` only asks Claude to
// do it in the session, under the permission rules of the person.
// A press is atomic on the lane state: it checks and marks in one `data.update`, so two quick presses act once.

import type { StoredItem } from '../../core/interfaces/items'
import type { KeySpec, TrackerContext } from '../../core/interfaces/tracker'
import type { ActionImpls, ViewContext } from '../../core/interfaces/view'
import type { GithubConfig } from './config'
import { conflictFiles } from './conflict-files'
import { githubKind } from './kind'
import { EMPTY_LANE } from './lane'
import { isFresh, type MergeEnv, mergeEnvOf } from './merge'
import { type FilesTarget, filesCheck, type ResolveTarget, resolveCheck, resolvePrompt } from './resolve'
import { prKeyOfRow } from './rows'
import type { ConflictFiles, GitHubRecord, LaneState, MergeNote } from './types'

type Ctx = TrackerContext<GithubConfig, LaneState>

/** The keys of the footer while a GitHub row is selected. Letters that no core key uses. */
export const KEYS: readonly KeySpec[] = [
  { id: 'resolve', key: 'c', label: 'resolve', scope: 'row' },
  { id: 'files', key: 'f', label: 'files', scope: 'row' },
]

/** The record of the PR a row belongs to. A file row under a PR acts for that PR (`prKeyOfRow`). */
const recordOf = (items: readonly StoredItem[], id: string | null): GitHubRecord | undefined => {
  const key = id === null ? undefined : prKeyOfRow(id)
  const item = key === undefined ? undefined : items.find(i => i.key === key)
  return (item && githubKind.decode(item)) || undefined
}

/** The lane state with `patch` set on the note of one PR. */
const withNote = (s: LaneState, key: string, patch: Partial<MergeNote>): LaneState => ({
  ...s,
  merge: { ...s.merge, [key]: { ...s.merge?.[key], ...patch } },
})

/** What a press reads, fresh: the record, the lane state, whether `gh` can be asked, and the time. */
async function read(tctx: Ctx, rowId: string) {
  const [items, state] = await Promise.all([tctx.items.list(), tctx.data.get()])
  const fresh = isFresh(tctx.tools.handle('gh')?.status())
  const now = tctx.clock.wall()
  const env = (s: LaneState): MergeEnv => ({ fresh, notes: s.merge ?? {}, now })
  return { rec: recordOf(items, rowId), state: state ?? EMPTY_LANE, env, now }
}

async function resolve(tctx: Ctx, row: string | null): Promise<void> {
  if (row === null) return
  const rowId = prKeyOfRow(row) // the note of a PR is under its key, also when the press came from a file row
  const { rec, state, env, now } = await read(tctx, rowId)
  const check = (s: LaneState) => resolveCheck(rec, env(s), s.defaultBranch)
  const first = check(state)
  if (!first.ok) {
    tctx.ui.toast(`resolve: ${first.why}`)
    return
  }
  // Check and mark in one write. A race re-runs it on the newer value, and only one press finds the PR not queued.
  const claim: { target?: ResolveTarget } = {}
  await tctx.data.update(cur => {
    claim.target = undefined
    const s = cur ?? EMPTY_LANE
    const c = check(s)
    if (!c.ok) return s
    claim.target = c.target
    return withNote(s, rowId, { queuedAt: now })
  })
  if (claim.target === undefined) return
  // Never awaited: a press may run inside a turn, where waiting for the turn it starts would hang. The engine answers
  // later: a prompt that a hook dropped is not queued, so the row must not say so and the person may press again.
  tctx.prompt.submit(resolvePrompt(claim.target), why => {
    void takeBack(tctx, rowId, now)
      .catch(() => undefined) // a store that fails here changes nothing for the person: the toast still tells them
      .then(() => tctx.ui.toast(`Resolve prompt refused: ${why}`))
  })
  tctx.ui.toast('Resolve prompt sent')
}

/** Takes the `queued` mark of the press at `at` off the PR. A later press, or a PR that changed since, keeps its note. */
const takeBack = (tctx: Ctx, key: string, at: number) =>
  tctx.data.update(cur => {
    const s = cur ?? EMPTY_LANE
    const note = s.merge?.[key]
    if (note?.queuedAt !== at) return s
    const { queuedAt: _refused, ...kept } = note
    return { ...s, merge: { ...s.merge, [key]: kept } }
  })

async function files(tctx: Ctx, row: string | null): Promise<void> {
  if (row === null) return
  const rowId = prKeyOfRow(row)
  const { rec, state, env, now } = await read(tctx, rowId)
  const check = (s: LaneState) => filesCheck(rec, env(s))
  const first = check(state)
  if (!first.ok) {
    tctx.ui.toast(`files: ${first.why}`)
    return
  }
  const claim: { target?: FilesTarget } = {}
  await tctx.data.update(cur => {
    claim.target = undefined
    const s = cur ?? EMPTY_LANE
    const c = check(s)
    if (!c.ok) return s
    claim.target = c.target
    return withNote(s, rowId, { files: { at: now, pending: true } })
  })
  const target = claim.target
  if (target === undefined) return
  const cwd = target.path ?? tctx.session.root() ?? (await tctx.session.cwd())
  const out = await conflictFiles((argv, opts) => tctx.tools.run('git', argv, opts), {
    cwd,
    head: target.head,
    base: target.base,
    timeoutMs: tctx.config.slice().gitTimeoutMs,
  })
  const found: ConflictFiles =
    'error' in out
      ? { at: tctx.clock.wall(), error: out.error }
      : { at: tctx.clock.wall(), files: out.files, ...(out.more !== undefined ? { more: out.more } : {}) }
  // A PR that stopped conflicting while git ran has no note any more: the answer is for a conflict that is gone.
  await tctx.data.update(cur => {
    const s = cur ?? EMPTY_LANE
    return s.merge?.[rowId] === undefined ? s : withNote(s, rowId, { files: found })
  })
}

/** The `run` and `state` of each key, at render. Reads only. */
export function actions(ctx: ViewContext<GithubConfig, LaneState>): ActionImpls<GithubConfig, LaneState> {
  const env = mergeEnvOf(ctx)
  const rec = (id: string | null) => recordOf(ctx.items, id)
  return {
    resolve: {
      state: id => (resolveCheck(rec(id), env, ctx.data?.defaultBranch).ok ? 'enabled' : 'disabled'),
      run: resolve,
    },
    files: { state: id => (filesCheck(rec(id), env).ok ? 'enabled' : 'disabled'), run: files },
  }
}
