// Kit tests of the questions tracker through the real hooks (issue #71): a `tool.call` of AskUserQuestion or ExitPlanMode
// reaches the tracker with its `tool_use_id`, `/track qa` prints the calls, and the copy key of the pane calls the engine's
// `ui.copy` with the Markdown of the selected call. The engine's tool answer and `ui.copy` are stubs beneath the mod.
import { expect } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import { test } from './fixtures/kit'
import { mountPane, select } from './fixtures/pane'
import { LIVE_ASK, LIVE_ESC, LIVE_PLAN_APPROVED, LIVE_QUESTIONS, PLAN } from './fixtures/questions'
import { START, track, until, world } from './fixtures/world'

/** The `tool.call` input of a hook: the arguments of the tool beside its name and its id. */
const argsOf = (input: Json): Record<string, unknown> => ({ ...(input as Record<string, unknown>) })

test('an AskUserQuestion call through the hook is kept with its tool_use_id, and /track qa prints it word for word', async ($, on) => {
  const { fake } = world(on)
  fake.toolAnswers.AskUserQuestion = LIVE_ASK.result
  await $.session.start(START)
  await $.tool.call(argsOf(LIVE_ASK.input) as never)
  const text = (await track($, 'qa')).text ?? ''
  expect(text.startsWith('# Questions and answers\n\n## Q1 · partial')).toBe(true)
  for (const q of LIVE_QUESTIONS) expect(text).toContain(q.question)
  expect(text).toContain(
    [
      '- [x] **Lint**: Biome and markdownlint.',
      '- [x] **Tests, all**: claude plugin test.',
      '- [ ] **E2E**: cucumber against a real claude.',
      '- [x] Other (typed): typed, with comma',
    ].join('\n'),
  )
  expect(text).toContain('_Notes only, no option picked._')
  expect(text).toContain('> Notes: keep it simple')
  expect((await track($, 'qa 1')).text).toBe(text.replace('# Questions and answers\n\n', ''))
})

test('an Esc is a declined call, and a plan the person approved is a call of its own', async ($, on) => {
  const { fake } = world(on)
  fake.toolAnswers.AskUserQuestion = LIVE_ESC.result
  fake.toolAnswers.ExitPlanMode = LIVE_PLAN_APPROVED.result
  await $.session.start(START)
  await $.tool.call(argsOf(LIVE_ESC.input) as never)
  await $.tool.call(argsOf(LIVE_PLAN_APPROVED.input) as never)
  const text = (await track($, 'qa')).text ?? ''
  expect(text).toContain('## Q1 · declined')
  // The words are the structured error of the result, which keeps the engine's `Error:` mark.
  expect(text).toContain("> Declined: Error: The user doesn't want to proceed")
  expect(text).toContain('## Q2 · plan approved')
  expect(text).toContain(PLAN.trimEnd())
})

test('the pane lists the call; the copy key puts its Markdown on the clipboard through ui.copy', async ($, on) => {
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  const { fake } = world(on)
  fake.toolAnswers.AskUserQuestion = LIVE_ASK.result
  await $.session.start(START)
  await $.tool.call(argsOf(LIVE_ASK.input) as never)
  await track($)
  const ui = await mountPane($, { bodyColumns: 100 })
  expect(await ui.find({ text: 'Questions' })).toBeDefined()
  await select($, ui, 'Q1')
  await ui.press({ key: 'questions.copy' })
  await until(() => copied.length > 0, 'the ui.copy call of the copy key')
  expect(copied).toHaveLength(1)
  expect(copied[0]?.startsWith('## Q1 · partial')).toBe(true)
  expect(copied[0]).toContain('Where should the records live?')
  await ui.unmount()
})

// Codex review of PR 191. One session can be drawn on two surfaces. A press of the copy key on the second one must copy on
// that one: with the surface left out, the engine takes the first, and the clipboard of the other client gets the text.
test('the copy key copies on the surface that the press came from, not on the first one', async ($, on) => {
  const surfaces: (string | undefined)[] = []
  on('ui.copy', (_$, e) => {
    surfaces.push(e.surface)
    return { value: { isCopied: true } }
  })
  const { fake } = world(on)
  fake.toolAnswers.AskUserQuestion = LIVE_ASK.result
  await $.session.start(START)
  await $.tool.call(argsOf(LIVE_ASK.input) as never)
  await track($)
  const terminal = await mountPane($, { bodyColumns: 100, surface: 'terminal' })
  const desktop = await mountPane($, { bodyColumns: 100, surface: 'desktop' })
  await select($, desktop, 'Q1')
  await desktop.press({ key: 'questions.copy' })
  await until(() => surfaces.length > 0, 'the ui.copy call of the press on the desktop surface')
  expect(surfaces).toEqual(['desktop'])
  await desktop.unmount()
  await terminal.unmount()
})
