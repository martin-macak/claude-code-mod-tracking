// An item runtime over fakePorts for the tests of the store, the funnel, the replay and the runtime. No engine, no `$`.
// `gh` and `acli` are answered by `w.run`: the same shapes the kit world answers. The runtime gets the context a
// TrackerHost gives the item host (`hostCtx`), so the session check, the dismiss list and the persist signal are the
// fakes of `hostWorld`.
import type { ReplayItem, RowEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { RepoRemote, RunResult } from '../../core/interfaces/ports'
import type { Tracker } from '../../core/interfaces/tracker'
import type { ItemRecord } from '../../hooks/contracts'
import { ItemRuntime } from '../../hooks/items/runtime'
import * as acliFx from './acli'
import * as ghFx from './gh'
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

/** The five item kinds as bare trackers, so the host's config can turn one off: `{ trackers: { web: { enabled: false } } }`. */
const KINDS = ['github', 'jira', 'artifact', 'file', 'web']
const kindTrackers = (): Tracker[] =>
  KINDS.map((id, i) => ({
    id,
    order: 10 * (i + 1),
    config: { defaults: { enabled: true }, normalise: (raw, defaults) => ({ ...defaults, ...raw }) },
    init: () => {},
    store: ctx => ctx.config.slice(),
  }))

export type ItemsOpts = {
  /** The session repo `ports.session.repo()` answers. Default `acme/web` on github.com. */
  remote?: RepoRemote | null
  /** Answers first. undefined falls through to the defaults. */
  run?: (argv: string[]) => RunResult | undefined | Promise<RunResult | undefined>
}

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

/** `off` turns item kinds off in the host's config (`github`, `jira`, `artifact`, `file`, `web`). */
export function itemsWorld(o: ItemsOpts & { off?: readonly string[] } = {}) {
  const t = hostWorld(kindTrackers(), {
    file: { trackers: Object.fromEntries((o.off ?? []).map(id => [id, { enabled: false }])) },
  })
  t.host.readToggles() // the start sequence does this before the item runtime starts
  t.w.session.repo = o.remote === undefined ? { host: 'github.com', owner: 'acme', repo: 'web' } : o.remote
  t.w.run = ghAcliRun(o)
  const rt = new ItemRuntime(t.w.ports.state)
  const ctx = t.host.hostCtx(t.w.ports)
  const started = async () => {
    await rt.start(ctx)
    await rt.settleProbes()
    return rt
  }
  const list = () => (t.w.state.get('items') ?? []) as unknown as ItemRecord[]
  const keys = () => list().map(r => r.key)
  return { ...t, rt, ctx, started, list, keys }
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
