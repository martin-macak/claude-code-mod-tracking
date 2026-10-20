// An item service over fakePorts for the tests of the store, the capture, the replay and the service. No engine, no `$`.
// `gh` and `acli` are answered by `w.run`: the same shapes the kit world answers. The service gets the context a
// TrackerHost gives the item host (`hostCtx`), so the session check, the dismiss list and the persist signal are the
// fakes of `hostWorld`. The service comes back un-started: a test calls `await items.start(hostCtx)` itself, so it sees
// every probe `start` issues.
import { ItemService } from '../../core/infra/items'
import type { ReplayItem, RowEvent } from '../../core/interfaces/events'
import type { Claim, Json, JsonObject } from '../../core/interfaces/items'
import type { RepoRemote, RunResult } from '../../core/interfaces/ports'
import type { Tracker } from '../../core/interfaces/tracker'
import { artifactTracker } from '../../trackers/artifact'
import { fileTracker } from '../../trackers/file'
import { githubTracker } from '../../trackers/github'
import { jiraTracker } from '../../trackers/jira'
import { webTracker } from '../../trackers/web'
import * as acliFx from './acli'
import type { ItemRecord, Ref } from './contracts'
import * as ghFx from './gh'
import { keyOf } from './keys'
import { reasonFor } from './reasons'
import { hostWorld } from './tracker-host'

declare function setTimeout(fn: () => void, ms: number): unknown
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export const res = (stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })

const SAMPLE = (
  JSON.parse(ghFx.BATCH_SAMPLE_OUTPUT) as { data: Record<string, { issueOrPullRequest: Record<string, unknown> }> }
).data
const ISSUE = SAMPLE.a!.issueOrPullRequest
/** What the fake GraphQL answers, by `owner/repo#N` (lower case). */
const NODES: Record<string, unknown> = {
  'cli/cli#14640': SAMPLE.b!.issueOrPullRequest,
  'acme/web#5': { ...ISSUE, number: 5, title: 'Web five', state: 'OPEN', stateReason: null },
  'acme/web#9': { ...ISSUE, number: 9, title: 'Web nine', state: 'OPEN', stateReason: null },
}

const ACLI_AUTH = acliFx.AUTH_STATUS_STDOUT.replace('<site>', 'acme')

function graphql(query: string): RunResult {
  const data: Record<string, unknown> = {}
  const re = /(a\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{\s*issueOrPullRequest\(number: (\d+)\)/g
  for (const m of query.matchAll(re)) data[m[1]!] = { issueOrPullRequest: NODES[`${m[2]}/${m[3]}#${m[4]}`] ?? null }
  return res(JSON.stringify({ data }))
}

function withKey(json: string, key: string): string {
  const o = JSON.parse(json) as { key: string }
  o.key = key
  return JSON.stringify(o)
}

export type ItemsOpts = {
  /** The session repo `ports.session.repo()` answers. Default `acme/web` on github.com. */
  remote?: RepoRemote | null
  /** Answers first. undefined falls through to the defaults. */
  run?: (argv: string[]) => RunResult | undefined | Promise<RunResult | undefined>
}

/** The five item trackers, as TRACKERS lists them: each brings its kind and its tool. */
export const itemTrackers = (): Tracker[] => [
  githubTracker(),
  jiraTracker(),
  webTracker(),
  artifactTracker(),
  fileTracker(),
]

/** The answers of gh and acli that the item tests share: versions, auth, GraphQL nodes, a Jira view. */
export function ghAcliRun(o: ItemsOpts = {}): (argv: string[]) => Promise<RunResult | undefined> {
  return async argv => {
    const custom = await o.run?.(argv)
    if (custom) return custom
    const [tool, a1, a2, a3, a4] = argv
    if (a1 === '--version') return res(tool === 'gh' ? 'gh version 2.102.0 (2026-09-30)' : 'acli version 1.3.19-stable')
    if (tool === 'gh' && a1 === 'api' && a2 === 'graphql') {
      const query = argv.find(x => x.startsWith('query='))?.slice('query='.length) ?? ''
      return graphql(query)
    }
    if (tool === 'gh' && a1 === 'auth') return res('Logged in')
    if (tool === 'gh' && a1 === 'repo') return res('{"nameWithOwner":"acme/web"}')
    if (tool === 'acli' && a2 === 'auth') return res(ACLI_AUTH)
    if (tool === 'acli' && a3 === 'view') return res(withKey(acliFx.TASK_VIEW_JSON, a4!))
    return undefined
  }
}

/**
 * `off` turns item trackers off in the host's config (`github`, `jira`, `artifact`, `file`, `web`). `file` is the config file
 * the host reads, e.g. `{ trackers: { github: { chunkSize: 2 } } }`; `off` adds to its `trackers`. `live` replaces what the
 * TrackerHost says is on. `trackers` replaces the five item trackers.
 */
export function fakeItems(
  o: ItemsOpts & {
    off?: readonly string[]
    file?: JsonObject
    live?: (id: string) => boolean
    trackers?: readonly Tracker[]
  } = {},
) {
  const trackers = o.trackers ?? itemTrackers()
  const config = {
    ...Object.fromEntries((o.off ?? []).map(id => [id, { enabled: false }])),
    ...((o.file?.trackers as JsonObject | undefined) ?? {}),
  }
  const t = hostWorld(trackers, { file: { ...(o.file ?? {}), trackers: config } })
  t.host.readToggles() // the start sequence does this before the item host starts
  t.w.session.repo = o.remote === undefined ? { host: 'github.com', owner: 'acme', repo: 'web' } : o.remote
  t.w.run = ghAcliRun(o)
  const dismiss = {
    list: async () => t.dismissed as ReadonlySet<string>,
    add: async (ids: readonly string[]) => {
      for (const id of ids) t.dismissed.add(id)
    },
  }
  const items = new ItemService({
    trackers,
    live: o.live ?? (id => t.host.live(id)),
    config: t.cfg,
    facts: t.facts,
    dismiss,
    watch: t.watch,
    persisted: () => void t.persisted.push('items'),
    state: t.w.ports.state,
    log: t.w.ports.log,
  })
  const hostCtx = t.host.hostCtx(t.w.ports)
  const started = async () => {
    await items.start(hostCtx)
    await items.settle()
    return items
  }
  const list = () => (t.w.state.get('items') ?? []) as unknown as ItemRecord[]
  const keys = () => list().map(r => r.key)
  return { ...t, world: t.w, items, hostCtx, dismiss, started, list, keys }
}

/** A claim of a ref, as a kind makes it: the ref fields under the category, seen at `at` from `source`. */
export function claimOf(ref: Ref, source = 'prompt', at = 10): Claim {
  const { category, ...fields } = ref
  return { category, key: keyOf(ref), source, reason: reasonFor(source), at, fields: fields as unknown as JsonObject }
}

/** Waits until a condition holds, for work the runtime starts and does not return (a refresh kick, a repo lookup). */
export async function until(cond: () => boolean, what = 'the condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await sleep(2)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export const graphqlCalls = (calls: string[][]) => calls.filter(c => c[0] === 'gh' && c[1] === 'api')

export function row(door: string, text: string, o: Partial<RowEvent> = {}): RowEvent {
  return { door, origin: 'composer', isMeta: false, hasMessage: true, text, ...o }
}

export const promptRow = (text: string, origin = 'composer', o: Partial<RowEvent> = {}) =>
  row('prompt', text, { origin, ...o })
export const commandRow = (text: string, origin = 'composer') => row('command', text, { origin })
export const responseRow = (text: string) => row('response', text, { origin: 'unclassified' })
export const toolResultRow = (text: string) => row('tool-result', text, { origin: 'unclassified' })

export const replayRow = (door: 'prompt' | 'response', text: string): ReplayItem => ({
  kind: 'row',
  ev: { door, origin: 'replay', isMeta: false, hasMessage: true, text },
})
export const replayTool = (tool: string, input: Json, use: Json): ReplayItem => ({
  kind: 'toolCall',
  ev: { tool, input, result: use },
})
