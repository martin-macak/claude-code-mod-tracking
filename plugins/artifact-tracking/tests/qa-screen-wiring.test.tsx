// Kit tests of `/track qa` on the screen only (issue #246) through the real hooks. Where a surface draws, `/track qa` answers a
// stub that names the call numbers, and a `ui.render` hook on `CommandOutput` rewrites the text of the row to the Markdown of
// exactly those calls. The stored row and the next request hold the stub: the kit cannot read a request, so these tests prove
// the reply (what the engine stores) and the rewrite (what `next` received), and the e2e scenario of questions.feature proves
// the request. The rules run in questions-markdown.test.ts, commands.test.ts and questions-tracker.test.ts.
// The kit answers `session.surfaces` from `world(on, { surfaces })`: `[]` by default (nothing draws), `['terminal']` here.
import type { On } from 'claude-code'
import { type Engine, expect } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import { test } from './fixtures/kit'
import { LIVE_ASK, LIVE_ESC } from './fixtures/questions'
import { current, START, track, world } from './fixtures/world'

const argsOf = (input: Json): Record<string, unknown> => ({ ...(input as Record<string, unknown>) })

/** The props of a `CommandOutput` row of `/track qa`, as the engine gives them (spike #196, "Observed shapes"). */
const row = (text: string, over: Record<string, unknown> = {}) => ({
  command: 'track',
  args: 'qa',
  text,
  isErrored: false,
  ...over,
})

type Seen = { text: string; [key: string]: unknown }

/**
 * Stands for the engine's own row, beneath the plugin. It keeps the props that `next` received: the text that the engine would
 * draw. The hook returns what `next` returns, so the tree here is the engine's row.
 */
function engineRow(on: On): Seen[] {
  const seen: Seen[] = []
  on('ui.render', (_$, e) => {
    seen.push((e as unknown as { props: Seen }).props)
    return { type: 'Text', props: {}, children: ['engine row'] }
  })
  return seen
}

/** Mounts the `CommandOutput` row of one command and gives back what `next` received. */
async function drawn($: Engine, seen: Seen[], props: Record<string, unknown>, viewport: Record<string, unknown> = {}) {
  const before = seen.length
  const ui = (await $.ui.mount({
    plugin: 'artifact-tracking',
    component: 'CommandOutput',
    requestId: 'row-1',
    surface: 'terminal',
    viewport: { columns: 100, rows: 30, isFullscreen: false, ...viewport },
    props,
  } as never)) as unknown as { unmount(): Promise<void> }
  await ui.unmount()
  return seen.slice(before)
}

/**
 * The Markdown of the calls that the mod holds, as the whole reply of `/track qa --send [n]` gives it, less the line break that
 * the reply starts with. It is what the row must draw: the rewrite replaces the whole drawn text, so it has no line break.
 */
const markdownOf = async ($: Engine, args = '') =>
  ((await track($, `qa --send ${args}`.trim())).text ?? '').replace(/^\n/, '')

async function twoCalls($: Engine, fake: ReturnType<typeof world>['fake']) {
  fake.toolAnswers.AskUserQuestion = LIVE_ASK.result
  await $.session.start(START)
  await $.tool.call(argsOf(LIVE_ASK.input) as never)
  fake.toolAnswers.AskUserQuestion = LIVE_ESC.result
  await $.tool.call(argsOf(LIVE_ESC.input) as never)
}

test('where a surface draws, /track qa answers the stub and /track qa --send the whole text', async ($, on) => {
  const { fake } = world(on, { surfaces: ['terminal'] })
  await twoCalls($, fake)
  const stub = (await track($, 'qa')).text ?? ''
  expect(stub).toBe(
    'Questions and answers Q1–Q2 (2 calls): drawn on the screen only. /track qa --send puts them in the context of the model.',
  )
  expect(stub).not.toContain('Where should the records live?')
  expect((await track($, 'qa 2')).text).toContain('Questions and answers Q2 (1 call)')
  const whole = (await track($, 'qa --send')).text ?? ''
  expect(whole.startsWith('\n# Questions and answers\n\n## Q1 · partial')).toBe(true)
  expect(whole).toContain('## Q2 · declined')
  expect(whole).toContain('Where should the records live?')
  const one = (await track($, 'QA --SEND 2')).text ?? ''
  expect(one.startsWith('\n## Q2 · declined')).toBe(true)
  expect(one).not.toContain('## Q1 ')
})

test('with no surface (claude -p, the SDK, the VS Code host) /track qa answers the whole text, as before', async ($, on) => {
  const { fake } = world(on, { surfaces: [] })
  await twoCalls($, fake)
  const text = (await track($, 'qa')).text ?? ''
  expect(text.startsWith('\n# Questions and answers\n\n## Q1 · ')).toBe(true)
  expect(text).toContain('Where should the records live?')
  expect((await track($, 'qa --send')).text).toBe(text)
})

test('the row of the stub draws the Markdown of the named calls; every other prop goes on as received', async ($, on) => {
  const { fake } = world(on, { surfaces: ['terminal'] })
  const seen = engineRow(on)
  await twoCalls($, fake)
  const stub = (await track($, 'qa')).text ?? ''
  const props = row(`artifact-tracking: ${stub}`, { onScreen: { first: 0, last: 28, of: 29 } })
  const got = await drawn($, seen, props, { isFullscreen: true })
  const markdown = await markdownOf($)
  expect(markdown.startsWith('# Questions and answers\n\n## Q1 · partial')).toBe(true)
  expect(got).toEqual([{ ...props, text: markdown }]) // onScreen too: a rewrite carries it on
  // The stored text is the stub, so the request holds the stub: the kit sees only the reply of the command.
  expect(stub).not.toContain('# Questions and answers')
})

test('the row of one call draws that call without the title', async ($, on) => {
  const { fake } = world(on, { surfaces: ['terminal'] })
  const seen = engineRow(on)
  await twoCalls($, fake)
  const stub = (await track($, 'qa 2')).text ?? ''
  const [got] = await drawn($, seen, row(`artifact-tracking: ${stub}`, { args: 'qa 2' }))
  expect(got?.text).toBe(await markdownOf($, '2'))
  expect(got?.text.startsWith('## Q2 · declined')).toBe(true)
})

test('an old row draws the same calls after more calls came', async ($, on) => {
  const { fake } = world(on, { surfaces: ['terminal'] })
  const seen = engineRow(on)
  await twoCalls($, fake)
  const stub = (await track($, 'qa')).text ?? ''
  const before = (await drawn($, seen, row(`artifact-tracking: ${stub}`)))[0]?.text
  expect(before).toContain('## Q2 · declined') // the Markdown, not the stub
  fake.toolAnswers.AskUserQuestion = LIVE_ASK.result
  await $.tool.call({ ...argsOf(LIVE_ASK.input), tool_use_id: 'later' } as never)
  expect(await markdownOf($)).toContain('## Q3 ') // a third call is there now
  const after = (await drawn($, seen, row(`artifact-tracking: ${stub}`)))[0]?.text
  expect(after).toBe(before)
  expect(after).not.toContain('## Q3 ')
})

test('the row is left to the engine for a --send row, a plain reply, an error, another command and a row of no stub', async ($, on) => {
  const { fake } = world(on, { surfaces: ['terminal'] })
  const seen = engineRow(on)
  await twoCalls($, fake)
  const stub = (await track($, 'qa')).text ?? ''
  const whole = (await track($, 'qa --send')).text ?? ''
  const same = async (props: Record<string, unknown>) => expect(await drawn($, seen, props)).toEqual([props])
  await same(row(`artifact-tracking: ${whole}`, { args: 'qa --send' })) // the row holds the whole text already
  await same(row(`artifact-tracking: ${whole}`)) // no stub in the text
  await same(row('artifact-tracking: Usage: /track qa [--send] [n]', { args: 'qa x' }))
  await same(row('artifact-tracking: No tracked items yet.', { args: '' }))
  await same(row(`artifact-tracking: ${stub}`, { isErrored: true }))
  await same(row(`artifact-tracking: ${stub}`, { command: 'other' })) // the row of another command
  await same(row(`artifact-tracking: ${stub}`, { args: 'turn 1' })) // a core word
})

test('a row that draws before the slot holds the calls keeps the stub, and draws once they are there', async ($, on) => {
  const { fake } = world(on, { surfaces: ['terminal'] })
  const seen = engineRow(on)
  const stub =
    'Questions and answers Q1–Q2 (2 calls): drawn on the screen only. /track qa --send puts them in the context of the model.'
  await $.session.start(START)
  const props = row(`artifact-tracking: ${stub}`)
  expect(await drawn($, seen, props)).toEqual([props]) // a resume: the row is there before the calls are
  await twoCalls($, fake)
  expect((await drawn($, seen, props))[0]?.text).toBe(await markdownOf($))
})

test('a failed read of the slot leaves the row to the engine', async ($, on) => {
  const { fake } = world(on, { surfaces: ['terminal'], isolateState: true })
  const seen = engineRow(on)
  await twoCalls($, fake)
  const stub = (await track($, 'qa')).text ?? ''
  current.failSlot = 'questions'
  const props = row(`artifact-tracking: ${stub}`)
  expect(await drawn($, seen, props)).toEqual([props])
})
