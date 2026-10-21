// A fake `gh` for a scenario. The harness puts `e2e/fake-gh/bin` first on PATH of claude, so the mod's `gh` is this one.
// It answers only the calls that the github tracker makes, from a spec file, and it never reaches the network.
// Any other call is refused and logged as unsupported, so a scenario that needs more fails loud (the step
// "the fake gh answered no unsupported call").
// The query formats come from `buildDiscoveryQuery` (trackers/github/pr-discovery.ts) and `buildQuery`
// (trackers/github/gh-tool.ts). The plugin test `tests/fake-gh-contract.test.ts` runs the real tool of the mod against
// `answer()`, so a change there shows in `make verify`, not only in a local `make e2e`.
// This file imports nothing, so the plugin tests can import it. `fake-gh-env.ts` holds what needs node.

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type FakePr = {
  number: number
  title: string
  headRefName: string
  baseRefName: string
  mergeable: Mergeable
  mergeStateStatus: string
  /** Default OPEN. */
  state?: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft?: boolean
}

export type FakeGhSpec = {
  owner: string
  repo: string
  defaultBranch: string
  prs: readonly FakePr[]
}

/** What one call gets. `call` names the kind of call for the log: `unsupported` for one the fake does not answer. */
export type FakeGhResult = { exitCode: number; stdout: string; stderr: string; call: string }

export type FakeGhCall = { call: string; exit: number; argv: string[] }

/** One plain name for an owner or a repo: what a GitHub URL and a git argument take without quoting. */
const OWNER_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

/** The owner and the repo of `owner/repo`. The one check that every part of the fake uses. */
export function parseOwnerRepo(ownerRepo: string): { owner: string; repo: string } {
  const m = OWNER_REPO.exec(ownerRepo)
  if (!m) throw new Error(`fake gh: expected owner/repo, got "${ownerRepo}"`)
  return { owner: m[1] as string, repo: m[2] as string }
}

export function fakeGhSpec(ownerRepo: string, defaultBranch: string, prs: readonly FakePr[]): FakeGhSpec {
  return { ...parseOwnerRepo(ownerRepo), defaultBranch, prs }
}

const ok = (call: string, stdout: string): FakeGhResult => ({ exitCode: 0, stdout, stderr: '', call })

const unsupported = (argv: readonly string[]): FakeGhResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `fake gh: unsupported call: ${argv.join(' ')}\n`,
  call: 'unsupported',
})

const prUrl = (spec: FakeGhSpec, number: number): string =>
  `https://github.com/${spec.owner}/${spec.repo}/pull/${number}`

/** The PR as the `pr` fragment of discovery and the refresh query read it. */
function node(spec: FakeGhSpec, pr: FakePr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state ?? 'OPEN',
    isDraft: pr.isDraft ?? false,
    url: prUrl(spec, pr.number),
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    isCrossRepository: false,
    reviewDecision: null,
    body: '',
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    closingIssuesReferences: { nodes: [] },
  }
}

const RATE = { cost: 1, remaining: 4999 }
const STRING = String.raw`"(?:[^"\\]|\\.)*"`
const REPOSITORY = new RegExp(String.raw`repository\(owner: (${STRING}), name: (${STRING})\)`)
const HEAD_ALIAS = new RegExp(String.raw`(h\d+): pullRequests\(headRefName: (${STRING})`, 'g')
const BASE_ALIAS = new RegExp(String.raw`(b\d+): pullRequests\(baseRefName: (${STRING})`, 'g')
const ITEM_ALIAS = new RegExp(
  String.raw`(a\d+): repository\(owner: (${STRING}), name: (${STRING})\) \{\s*issueOrPullRequest\(number: (\d+)\)`,
  'g',
)

const isHere = (spec: FakeGhSpec, owner: string, repo: string): boolean => owner === spec.owner && repo === spec.repo

const notFound = (path: string[], what: string) => ({
  type: 'NOT_FOUND',
  path,
  message: `Could not resolve to ${what}.`,
})

/** `gh api graphql` exits 1 when the reply has errors, and prints the reply all the same. */
function reply(call: string, data: Record<string, unknown>, errors: unknown[]): FakeGhResult {
  const body = JSON.stringify({ data: { rateLimit: RATE, ...data }, ...(errors.length > 0 ? { errors } : {}) })
  return {
    exitCode: errors.length > 0 ? 1 : 0,
    stdout: `${body}\n`,
    stderr: errors.length > 0 ? 'gh: Could not resolve to a repository or an item.\n' : '',
    call,
  }
}

function discovery(query: string, spec: FakeGhSpec): FakeGhResult {
  const m = REPOSITORY.exec(query)
  const owner: string = JSON.parse(m?.[1] ?? '""')
  const repo: string = JSON.parse(m?.[2] ?? '""')
  if (!isHere(spec, owner, repo))
    return reply('graphql discovery', { repository: null }, [
      notFound(['repository'], `a Repository with the name '${owner}/${repo}'`),
    ])
  const repository: Record<string, unknown> = { defaultBranchRef: { name: spec.defaultBranch } }
  for (const [, alias, quoted] of query.matchAll(HEAD_ALIAS)) {
    const branch: string = JSON.parse(quoted ?? '""')
    repository[alias ?? ''] = { nodes: spec.prs.filter(p => p.headRefName === branch).map(p => node(spec, p)) }
  }
  for (const [, alias, quoted] of query.matchAll(BASE_ALIAS)) {
    const branch: string = JSON.parse(quoted ?? '""')
    repository[alias ?? ''] = {
      nodes: spec.prs.filter(p => p.baseRefName === branch && (p.state ?? 'OPEN') === 'OPEN').map(p => node(spec, p)),
    }
  }
  return reply('graphql discovery', { repository }, [])
}

function refresh(query: string, spec: FakeGhSpec): FakeGhResult {
  const data: Record<string, unknown> = {}
  const errors: unknown[] = []
  for (const [, alias = '', quotedOwner, quotedRepo, number] of query.matchAll(ITEM_ALIAS)) {
    const owner: string = JSON.parse(quotedOwner ?? '""')
    const repo: string = JSON.parse(quotedRepo ?? '""')
    if (!isHere(spec, owner, repo)) {
      data[alias] = null
      errors.push(notFound([alias], `a Repository with the name '${owner}/${repo}'`))
      continue
    }
    const pr = spec.prs.find(p => p.number === Number(number))
    data[alias] = { issueOrPullRequest: pr ? { __typename: 'PullRequest', ...node(spec, pr) } : null }
  }
  return reply('graphql refresh', data, errors)
}

/** The query text of `gh api graphql ... -f query=<text>`, or undefined when the call has none. */
function queryOf(argv: readonly string[]): string | undefined {
  const i = argv.findIndex((a, at) => a === '-f' && argv[at + 1]?.startsWith('query='))
  return i < 0 ? undefined : argv[i + 1]?.slice('query='.length)
}

/** The answer to one `gh` call (`argv` without the program name). Pure: the shim does the I/O. */
export function answer(argv: readonly string[], spec: FakeGhSpec): FakeGhResult {
  const [first, second] = argv
  if (first === '--version') return ok('--version', 'gh version 2.99.0 (fake)\n')
  if (first === 'auth' && second === 'status') return ok('auth status', 'github.com\n  Logged in (fake gh)\n')
  // Claude Code runs this itself, at start, for its own PR status. No token: it cannot call GitHub for the fake repo.
  if (first === 'auth' && second === 'token')
    return { exitCode: 1, stdout: '', stderr: 'no oauth token found for github.com\n', call: 'auth token' }
  if (first === 'repo' && second === 'view')
    return ok(
      'repo view',
      `${JSON.stringify({
        nameWithOwner: `${spec.owner}/${spec.repo}`,
        url: `https://github.com/${spec.owner}/${spec.repo}`,
      })}\n`,
    )
  if (first === 'api' && second === 'graphql') {
    const query = queryOf(argv)
    if (query?.includes('defaultBranchRef')) return discovery(query, spec)
    if (query?.includes('issueOrPullRequest(')) return refresh(query, spec)
  }
  return unsupported(argv)
}

/**
 * Whether the log of the fake has been quiet for `seconds`: `idle` is how long ago the log last changed (undefined: no log
 * file). The log starts empty, so an empty log is never quiet: no call has reached the fake yet, and a wait that passed on
 * it would pass with no call at all.
 */
export function isQuiet(calls: readonly FakeGhCall[], idle: number | undefined, seconds: number): boolean {
  return calls.length > 0 && idle !== undefined && idle >= seconds * 1000
}

const MAX_ARG = 200

/** One line of the call log. A long argument (the query) is cut, because the call name says what it was. */
export function logLineOf(argv: readonly string[], result: FakeGhResult): string {
  const short = argv.map(a => (a.length > MAX_ARG ? `${a.slice(0, MAX_ARG - 1)}…` : a))
  return JSON.stringify({ call: result.call, exit: result.exitCode, argv: short })
}

/** The calls of a log file, one per line. A line that is not a call is skipped. */
export function callsOf(text: string): FakeGhCall[] {
  const calls: FakeGhCall[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const c: unknown = JSON.parse(line)
      if (typeof c === 'object' && c !== null && 'call' in c && 'exit' in c && 'argv' in c) calls.push(c as FakeGhCall)
    } catch {
      // A half-written line: the next read has it whole.
    }
  }
  return calls
}
