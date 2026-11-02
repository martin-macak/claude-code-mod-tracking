// A fake `acli` for a scenario (issue #226). The harness puts `e2e/fake-acli/bin` first on PATH of claude, so the mod's `acli`
// and the `acli` a Bash call of the model runs are this one. It answers only the calls that the jira tracker makes for one
// work item, from a spec file, and it never reaches the network and never reads a credential or the acli config of the person.
// Any other call is refused and logged as unsupported, so a scenario that needs more fails loud (the step "the fake acli
// answered no unsupported call"). That includes `workitem search`, so an Epic cannot be faked yet: see e2e/README.md.
// The outputs follow the facts of the KB (docs/knowledge-base/claude-code-artifact-tracking/jira.md, sections 1, 2 and 6):
// `auth status` prints a `Site:` line, `view --json` prints one Jira REST object, an unknown key fails with the text acli uses.
// The contract test `scripts/contracts/fake-acli-contract.test.mjs` runs the real `AcliTool` of the mod against `answer()`, so a
// change there shows in `make verify`, not only in a local `make e2e`.
// This file imports only a type of `fake-cli.ts`, so the plugin tests can import it. `fake-acli-env.ts` needs node.

import type { FakeResult } from './fake-cli.ts'

export type StatusCategory = 'new' | 'indeterminate' | 'done'

/** One work item. `subtasks` are listed in the `fields.subtasks` of the item, as Jira lists them. */
export type FakeWorkitem = {
  key: string
  summary: string
  issueType: string
  status: string
  statusCategory: StatusCategory
  subtasks?: readonly FakeWorkitem[]
}

/**
 * What the fake answers. `site` is the host of the one site that acli is logged in to: `null` is a machine that is not logged
 * in. `items` are the work items of that site, by key.
 */
export type FakeAcliSpec = {
  site: string | null
  items: readonly FakeWorkitem[]
}

/** The call names of the log, one for each call the fake answers. `unsupported` is not one. */
export const FAKE_ACLI_CALLS = ['--version', 'jira auth status', 'jira workitem view'] as const

/** `call` is a name of `FAKE_ACLI_CALLS` or `unsupported`, so the compiler holds the list to `answer()`. */
export type FakeAcliResult = FakeResult & { call: (typeof FAKE_ACLI_CALLS)[number] | 'unsupported' }

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/
/** The same shape as `JIRA_KEY` of the tracker (trackers/jira/urls.ts). The contract test checks it. */
const KEY = /^[A-Z][A-Z0-9_]+-\d+$/

export function fakeAcliSpec(site: string | null, items: readonly FakeWorkitem[]): FakeAcliSpec {
  if (site !== null && !HOST.test(site)) throw new Error(`fake acli: expected a site host, got "${site}"`)
  const check = (item: FakeWorkitem): void => {
    if (!KEY.test(item.key)) throw new Error(`fake acli: "${item.key}" is not a Jira key`)
    for (const sub of item.subtasks ?? []) check(sub)
  }
  for (const item of items) check(item)
  return { site, items }
}

const ok = (call: FakeAcliResult['call'], stdout: string): FakeAcliResult => ({ exitCode: 0, stdout, stderr: '', call })
const fail = (call: FakeAcliResult['call'], stderr: string): FakeAcliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `${stderr}\n`,
  call,
})

const unsupported = (argv: readonly string[]): FakeAcliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `fake acli: unsupported call: ${argv.join(' ')}\n`,
  call: 'unsupported',
})

/** The issue as the Jira REST shape that `acli ... view --json` prints, with the fields that were asked (all when none). */
function issue(item: FakeWorkitem, fields: ReadonlySet<string> | undefined): Record<string, unknown> {
  const all: Record<string, unknown> = {
    issuetype: { name: item.issueType },
    status: { name: item.status, statusCategory: { key: item.statusCategory } },
    summary: item.summary,
    subtasks: (item.subtasks ?? []).map(s => issue(s, new Set(['issuetype', 'status', 'summary']))),
  }
  const chosen = Object.entries(all).filter(([name]) => fields === undefined || fields.has(name))
  return { key: item.key, fields: Object.fromEntries(chosen) }
}

function view(args: readonly string[], spec: FakeAcliSpec): FakeAcliResult {
  const call = 'jira workitem view' as const
  let key: string | undefined
  let fields: Set<string> | undefined
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--json') json = true
    else if (a === '--fields' || a === '-f') fields = new Set((args[++i] ?? '').split(',').filter(Boolean))
    else if (a.startsWith('--fields=')) fields = new Set(a.slice('--fields='.length).split(',').filter(Boolean))
    else if (!a.startsWith('-') && key === undefined) key = a
  }
  if (key === undefined) return fail(call, 'argument [key] is required')
  // Not logged in: acli says "failed to fetch work item details" for a view, with no word of "unauthorized" (KB jira.md, 6).
  if (spec.site === null) return fail(call, 'failed to fetch work item details')
  const item = spec.items.find(i => i.key === key)
  if (!item) return fail(call, 'Issue does not exist or you do not have permission to see it.')
  if (json) return ok(call, `${JSON.stringify(issue(item, fields))}\n`)
  return ok(call, `Key: ${item.key}\nType: ${item.issueType}\nStatus: ${item.status}\nSummary: ${item.summary}\n`)
}

/** The answer to one `acli` call (`argv` without the program name). Pure: the shim does the I/O. */
export function answer(argv: readonly string[], spec: FakeAcliSpec): FakeAcliResult {
  const [first, second, third] = argv
  if (argv.length === 1 && first === '--version') return ok('--version', 'acli version 1.3.19-stable (fake)\n')
  if (first === 'jira' && second === 'auth' && third === 'status') {
    if (spec.site === null) return fail('jira auth status', "unauthorized: use 'acli jira auth login' to authenticate")
    return ok(
      'jira auth status',
      `✓ Authenticated\n  Site: ${spec.site}\n  Email: fake@example.invalid\n  Authentication Type: oauth_global\n`,
    )
  }
  if (first === 'jira' && second === 'workitem' && third === 'view') return view(argv.slice(3), spec)
  return unsupported(argv)
}
