// The cap on the config problems (issue #144): the first 50, then one count line. The log keeps every problem. The cap
// sits in the ConfigManager, so every reader of `problems()` shows the same list. Pure.
import { expect, test } from 'claude-code/testing'
import type { DocSpec } from '../core/infra/config-file'
import { ConfigManager } from '../core/infra/config-manager'
import type { EnvName, Ports } from '../core/interfaces/ports'
import type { PaneKey } from '../core/interfaces/view'
import { capProblems, MAX_PROBLEMS, moreLine, namedProblems } from '../core/lib/problems'
import { helpOf, helpTextOf, type PaneHost } from '../hooks/pane-text'
import { GITHUB_DEFAULTS, githubConfig } from '../trackers/github/config'
import { fakeConfigFs } from './fixtures/config-fs'
import { expectLinear } from './fixtures/scaling'

const P = '/h/.config/claude-code/mods/tracker/config.json'
const SPECS: readonly DocSpec[] = [{ id: 'github', config: githubConfig }]
const UNKNOWN = ': unknown key. The mod keeps it and ignores it.'

/** A file whose `global` block holds `n` unknown keys: one problem each. (A top-level unknown key is no problem.) */
const unknownKeys = (n: number): string =>
  JSON.stringify({ global: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i])) })

/** The place of the debug log the count line names when `HOME` is `/h` and `CLAUDE_CONFIG_DIR` is unset. */
const LOG = '/h/.claude/debug/latest'
/** The count line of a manager that runs with `HOME=/h`. */
const count = (n: number): string => moreLine(n, LOG)

function make(text: string, env: Partial<Record<EnvName, string>> = { HOME: '/h' }, path = P) {
  const fake = fakeConfigFs({ [path]: text })
  const log: string[] = []
  const manager = new ConfigManager({
    fs: fake.fs,
    env: { get: async (name: EnvName) => env[name] },
    specs: SPECS,
    log: line => void log.push(line),
  })
  return { fake, log, manager }
}

test('the cap is 50 and the count line says how many problems it leaves out and where the log is', () => {
  expect(MAX_PROBLEMS).toBe(50)
  expect(moreLine(4950)).toBe('4950 more problems: see the debug log (claude --debug)')
  expect(moreLine(1)).toBe('1 more problem: see the debug log (claude --debug)')
  expect(moreLine(4950, '/c/debug/latest')).toBe('4950 more problems: see /c/debug/latest (claude --debug)')
  expect(moreLine(1, '/c/debug/latest')).toBe('1 more problem: see /c/debug/latest (claude --debug)')
})

test('capProblems keeps 50 or fewer problems as they are, with no count line', () => {
  const none = capProblems([])
  expect(none).toEqual({ list: [], more: undefined })
  const fifty = Array.from({ length: 50 }, (_, i) => `P${i}.`)
  expect(capProblems(fifty)).toEqual({ list: fifty, more: undefined })
})

test('capProblems keeps the first 50 and adds one count line for the rest', () => {
  const all = Array.from({ length: 5000 }, (_, i) => `P${i}.`)
  const { list, more } = capProblems(all)
  expect(list).toHaveLength(51)
  expect(list.slice(0, 50)).toEqual(all.slice(0, 50))
  expect(list[50]).toBe(moreLine(4950))
  expect(more).toEqual({ count: 4950, line: moreLine(4950) }) // the count and the line, so no reader takes it from the list
  expect(capProblems([...all.slice(0, 50), 'P50.']).list.at(-1)).toBe(moreLine(1))
})

test('capProblems names the place of the log in its count line when it gets one', () => {
  const { list, more } = capProblems(
    Array.from({ length: 60 }, (_, i) => `P${i}.`),
    '/c/debug/latest',
  )
  expect(list[50]).toBe('10 more problems: see /c/debug/latest (claude --debug)')
  expect(more).toEqual({ count: 10, line: list[50] })
})

test('namedProblems drops the count line of a capped list and nothing else', () => {
  const all = Array.from({ length: 60 }, (_, i) => `P${i}.`)
  const { list, more } = capProblems(all)
  expect(namedProblems(list, more)).toEqual(all.slice(0, 50))
  expect(namedProblems(['A.', 'B.'], undefined)).toEqual(['A.', 'B.'])
})

test('a config with 5000 unknown keys gives 50 problems and one count line, and the log holds all 5000', async () => {
  const { manager, log } = make(unknownKeys(5000))
  await manager.refresh()
  const list = manager.problems()
  expect(list).toHaveLength(51)
  expect(list[0]).toBe(`global.k0${UNKNOWN}`)
  expect(list[49]).toBe(`global.k49${UNKNOWN}`)
  expect(list[50]).toBe(`4950 more problems: see ${LOG} (claude --debug)`)
  expect(manager.moreProblems()).toEqual({ count: 4950, line: list[50] })
  const logged = log.filter(l => l.startsWith('config: global.k'))
  expect(logged).toHaveLength(5000)
  expect(logged[0]).toBe(`config: global.k0${UNKNOWN}`)
  expect(logged[4999]).toBe(`config: global.k4999${UNKNOWN}`)
  expect(log.some(l => l.includes('more problems'))).toBe(false) // the count line is no problem: the log has the real ones
})

// The cost of the problem path (issue #219): refresh() reads and normalises the file, reports every problem once, and
// problems() caps the list. Each step grows with the number of bad keys, so 4 times the keys must cost less than 12 times
// the time. The base is 10000 keys, so the big input is 40000 (fixtures/scaling.ts, "Pick a base size"). At 5000 a plain
// quadratic step (an array `includes` in report()) stays under the ratio of 12 (10.4 to 11.8 measured) and only the CPU
// ceiling fires, with a 1.6 times margin. The `log` port only pushes each line to an array: what the real engine does
// with the lines is the engine's cost, measured live (KB, issue #219).
const BASE_KEYS = 10_000

test('refresh, problems and the log of the problems grow linearly with the number of unknown keys', async () => {
  await expectLinear({
    label: 'config problems',
    make: k => ({ n: BASE_KEYS * k, text: unknownKeys(BASE_KEYS * k) }),
    run: async ({ n, text }) => {
      const { manager, log } = make(text)
      await manager.refresh()
      const list = manager.problems()
      expect(list).toHaveLength(MAX_PROBLEMS + 1) // the work ran: 50 problems and one count line
      expect(manager.moreProblems()?.count).toBe(n - MAX_PROBLEMS)
      expect(log).toHaveLength(n) // every problem went to the log port, once
    },
  })
})

test('exactly 50 problems show no count line, 51 show 50 and a count of one', async () => {
  const fifty = make(unknownKeys(50))
  await fifty.manager.refresh()
  expect(fifty.manager.problems()).toHaveLength(50)
  expect(fifty.manager.problems().some(p => p.includes('more problem'))).toBe(false)
  expect(fifty.manager.moreProblems()).toBeUndefined()
  const over = make(unknownKeys(51))
  await over.manager.refresh()
  expect(over.manager.problems()).toHaveLength(51)
  expect(over.manager.problems()[50]).toBe(`1 more problem: see ${LOG} (claude --debug)`)
  expect(over.manager.moreProblems()?.count).toBe(1)
  expect(over.log.filter(l => l.startsWith('config: global.k'))).toHaveLength(51)
})

test('refresh returns true when only the count past the cap changed', async () => {
  const { fake, manager } = make(unknownKeys(60))
  await manager.refresh()
  expect(manager.problems()[50]).toBe(count(10))
  fake.edit(P, unknownKeys(70))
  expect(await manager.refresh()).toBe(true)
  expect(manager.problems()[50]).toBe(count(20))
  fake.edit(P, unknownKeys(3))
  expect(await manager.refresh()).toBe(true)
  expect(manager.problems()).toHaveLength(3)
  expect(manager.moreProblems()).toBeUndefined()
})

test('the count line names the default place of the debug log: CLAUDE_CONFIG_DIR, else ~/.claude', async () => {
  const dir = make(unknownKeys(60), { HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })
  await dir.manager.refresh()
  expect(dir.manager.problems()[50]).toBe('10 more problems: see /c/debug/latest (claude --debug)')
  const home = make(unknownKeys(60), { HOME: '/h' })
  await home.manager.refresh()
  expect(home.manager.problems()[50]).toBe('10 more problems: see /h/.claude/debug/latest (claude --debug)')
})

test('the count line names no place when the mod cannot compute one', async () => {
  // The config folder is set by the override, so the file is read, but no absolute Claude config folder exists.
  const { manager } = make(unknownKeys(60), { CLAUDE_TRACKER_CONFIG_DIR: '/t' }, '/t/config.json')
  await manager.refresh()
  expect(manager.problems()[50]).toBe('10 more problems: see the debug log (claude --debug)')
})

test('a refused write stays inside the 50 when the file has 50 or more other problems', async () => {
  const { fake, log, manager } = make(unknownKeys(60))
  fake.deny.write = 'EACCES: permission denied'
  await manager.reconcile(new Map([['github', GITHUB_DEFAULTS]]))
  const list = manager.problems()
  expect(list).toHaveLength(51)
  expect(list[0]).toBe('The mod cannot write the file: EACCES: permission denied. It tries again at the next start.')
  expect(list[1]).toBe(`global.k0${UNKNOWN}`)
  expect(list[50]).toBe(count(11))
  expect(manager.moreProblems()?.count).toBe(11)
  expect(log.filter(l => l.startsWith('config: '))).toHaveLength(61) // the log holds the 60 keys and the refused write
})

// ---------------------------------------------------------------- the help view over the capped config problems

const KEY: PaneKey = { id: 'refresh', key: 'r', label: 'refresh', scope: 'pane', owner: 'core' }
const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `P${i + 1}.`)

/** What `helpOf` reads of the pane host: the keys, a config source with the cap, the key problems and the version. */
function paneHost(configProblems: readonly string[], keyProblems: readonly string[], log?: string) {
  const { list, more } = capProblems(configProblems, log)
  return {
    keys: { all: () => [KEY] },
    config: { path: () => '/c/config.json', problems: () => list, moreProblems: () => more },
    problems: () => keyProblems,
    version: '1.2.3',
    paneData: async () => [],
  } as unknown as Pick<PaneHost, 'keys' | 'config' | 'problems' | 'version' | 'paneData'>
}

test('helpOf takes the 50 problems of the config without the count line, and the count apart', () => {
  const m = helpOf(paneHost(many(60), ['K.']), [])
  expect(m.problems).toEqual([...many(50), 'K.'])
  expect(m.moreProblems).toEqual({ count: 10, line: moreLine(10) }) // the line is the config's own count line
})

test('helpOf takes the count line the config gives, with its place of the log, and does not rebuild it', () => {
  const m = helpOf(paneHost(many(60), ['K.'], '/c/debug/latest'), [])
  expect(m.moreProblems).toEqual({ count: 10, line: '10 more problems: see /c/debug/latest (claude --debug)' })
  // The line comes from `moreProblems()`, not from the last entry of `problems()`.
  const host = paneHost(many(60), [])
  const config = { ...host.config, moreProblems: () => ({ count: 10, line: 'THE LINE' }) }
  expect(helpOf({ ...host, config }, []).moreProblems).toEqual({ count: 10, line: 'THE LINE' })
})

test('helpOf with 50 problems or fewer has no count', () => {
  const m = helpOf(paneHost(many(50), ['K.']), [])
  expect(m.problems).toEqual([...many(50), 'K.'])
  expect(m.moreProblems).toBeUndefined()
})

test('/track help prints the 50 problems, the key problems, then the one count line last', async () => {
  const text = await helpTextOf({} as Ports, paneHost(many(60), ['K.'], '/c/debug/latest'))
  const lines = text.split('\n')
  expect(lines.slice(lines.indexOf('Problems') + 1)).toEqual([
    ...many(50).map(p => `  ${p}`),
    '  K.',
    '  10 more problems: see /c/debug/latest (claude --debug)',
  ])
})
