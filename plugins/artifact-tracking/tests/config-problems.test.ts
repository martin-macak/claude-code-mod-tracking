// Config problems in `/track`: the text block (copy H), and which replies carry it. The config is a fake with a path and a
// list of problems, so the test sees the order of the calls and the exact text. Plan: L4 Task 6 (decision C6).
import { expect, test } from 'claude-code/testing'
import { problemsText } from '../core/infra/commands'
import { capProblems } from '../core/lib/problems'
import { type FakeConfig, fakeConfig } from './fixtures/config-fs'
import { promptRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

const PATH = '/p/config.json'
const USAGE =
  'Usage: /track [refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <high|normal|low|auto>]'

test('problemsText is empty with no problem', () => {
  expect(problemsText(PATH, [])).toBe('')
  expect(problemsText(undefined, [])).toBe('')
})

test('problemsText lists each problem under the path', () => {
  expect(problemsText('/h/.config/claude-code/mods/tracker/config.json', ['A.', 'B.'])).toBe(
    'Config problems in /h/.config/claude-code/mods/tracker/config.json:\n  A.\n  B.',
  )
})

test('problemsText with no path', () => {
  expect(problemsText(undefined, ['A.'])).toBe('Config problems:\n  A.')
})

test('problemsText shows ten problems and a count of the rest', () => {
  const lines = (n: number) =>
    problemsText(
      PATH,
      Array.from({ length: n }, (_, i) => `P${i + 1}.`),
    ).split('\n')
  const twelve = lines(12)
  expect(twelve).toHaveLength(12) // the header, ten problems, the count
  expect(twelve[10]).toBe('  P10.')
  expect(twelve[11]).toBe('  and 2 more problems: see /track help.')
  expect(lines(11)[11]).toBe('  and 1 more problem: see /track help.')
  expect(lines(10)).toHaveLength(11) // exactly ten: no count line
})

function world(o: { problems?: readonly string[]; path?: string | undefined } = {}) {
  let cfg: FakeConfig | undefined
  const w = managerWorld({
    config: specs =>
      (cfg = fakeConfig({ specs, ...(o.path !== undefined ? { path: o.path } : {}), problems: o.problems ?? [] })),
  })
  const fake = cfg as FakeConfig
  const run = (args: string) => w.m.track(w.w.ports, args)
  const refreshes = () => fake.calls.filter(c => c === 'refresh').length
  return { ...w, fake, run, refreshes }
}

test("'' refreshes the config first, then appends the problems", async () => {
  const t = world({ path: PATH, problems: ['X.'] })
  const out = await t.run('')
  expect(out.text).toBe('No tracked items yet.\n\nConfig problems in /p/config.json:\n  X.')
  expect(t.fake.calls[0]).toBe('refresh')
  expect(t.refreshes()).toBe(2) // the start's read and the command's own check
})

test('with no problem the text is unchanged', async () => {
  const t = world({ path: PATH })
  expect((await t.run('')).text).toBe('No tracked items yet.')
})

test('refresh and prio append the problems; clear and the usage line do not', async () => {
  const t = world({ path: PATH, problems: ['X.'] })
  await t.m.row(t.w.ports, promptRow('see https://github.com/acme/web/issues/9'))
  const block = '\n\nConfig problems in /p/config.json:\n  X.'
  expect((await t.run('refresh')).text).toMatch(/#9[\s\S]*\n\nConfig problems in \/p\/config\.json:\n {2}X\.$/)
  expect(t.refreshes()).toBe(2)
  const prio = (await t.run('prio #9 high')).text ?? ''
  expect(prio.endsWith(block)).toBe(true)
  expect(t.refreshes()).toBe(2) // prio does not check the file
  expect((await t.run('clear')).text).toBe('Tracking list cleared.')
  expect((await t.run('bogus')).text).toBe(USAGE)
  expect((await t.run('prio #99 high')).text).toBe('Not tracked: #99')
})

test('help lists the config problems itself, once, after the config check', async () => {
  const t = world({ path: PATH, problems: ['X.'] })
  const out = await t.run('help')
  expect(out.text.endsWith(`Config file: ${PATH}\nVersion: unknown\nProblems\n  X.`)).toBe(true) // no manifest here
  expect(out.text).not.toContain('Config problems in')
  expect(t.refreshes()).toBe(2) // the start's read and the command's own check
})

test('a command with no path in the config says so in the header', async () => {
  const t = world({ problems: ['X.'] })
  expect((await t.run('')).text).toBe('No tracked items yet.\n\nConfig problems:\n  X.')
})

test('a command that finds the file changed redraws the pane through refreshConfig', async () => {
  const t = world({ path: PATH })
  await t.run('')
  t.fake.set({ trackers: { github: { chunkSize: 10 } } })
  await t.run('')
  expect(t.w.ui.invalidated).toBe(1)
})

// ---------------------------------------------------------------- the cap on the problems (issue #144)

const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `P${i + 1}.`)
const COUNT = (n: number): string => `${n} more problems: see the debug log (claude --debug)`

test('problemsText counts the problems the config left out with the ones it cuts at ten', () => {
  const { list, more } = capProblems(many(60))
  const lines = problemsText(PATH, list, more).split('\n')
  expect(lines).toHaveLength(12) // the header, ten problems, the count
  expect(lines[10]).toBe('  P10.')
  expect(lines[11]).toBe('  and 50 more problems: see /track help.') // 40 more of the 50 listed, and the 10 left out
  const over = capProblems(many(51))
  expect(problemsText(PATH, over.list, over.more).split('\n')[11]).toBe('  and 41 more problems: see /track help.')
})

test('problemsText with the config cap at work never prints the count line as a problem', () => {
  const { list, more } = capProblems(many(5000))
  const text = problemsText(PATH, list, more)
  expect(text).not.toContain('debug log')
  expect(text.split('\n').at(-1)).toBe('  and 4990 more problems: see /track help.')
})

test('problemsText of a list with no cap is as before', () => {
  expect(problemsText(PATH, ['A.', 'B.'], undefined)).toBe(`Config problems in ${PATH}:\n  A.\n  B.`)
  expect(problemsText(PATH, ['A.', 'B.'])).toBe(`Config problems in ${PATH}:\n  A.\n  B.`)
})

test('/track with 60 config problems lists ten and counts the other 50', async () => {
  const t = world({ path: PATH, problems: many(60) })
  const text = (await t.run('')).text
  expect(text.split('\n').slice(-12)).toEqual([
    `Config problems in ${PATH}:`,
    ...many(10).map(p => `  ${p}`),
    '  and 50 more problems: see /track help.',
  ])
})

test('/track help with 60 config problems prints the first 50, then one line that counts the rest', async () => {
  const t = world({ path: PATH, problems: many(60) })
  const lines = (await t.run('help')).text.split('\n')
  const at = lines.indexOf('Problems')
  expect(lines.slice(at + 1)).toEqual([...many(50).map(p => `  ${p}`), `  ${COUNT(10)}`])
  expect((await t.run('help')).text).not.toContain('Config problems in')
})

test('/track help with exactly 50 config problems prints all of them and no count line', async () => {
  const t = world({ path: PATH, problems: many(50) })
  const lines = (await t.run('help')).text.split('\n')
  expect(lines.slice(lines.indexOf('Problems') + 1)).toEqual(many(50).map(p => `  ${p}`))
})
