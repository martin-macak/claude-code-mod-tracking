// The path rule of the config file (spec 5.7): the override names the whole folder, else XDG, else HOME. The place of
// the debug log that the count line of the config problems names (issue #144). Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 3 (decision C9).
import { expect, test } from 'claude-code/testing'
import { CONFIG_TAIL, resolveConfigPath, resolveDebugLog } from '../core/infra/config-path'
import type { EnvName } from '../core/interfaces/ports'

/** An env port over a plain record. A name that is not in the record reads as unset. */
const envOf = (vars: Partial<Record<EnvName, string>>) => ({
  get: async (name: EnvName): Promise<string | undefined> => vars[name],
})

const HOME_PATH = '/h/.config/claude-code/mods/tracker/config.json'

test('the tail of the path is claude-code/mods/tracker/config.json', () => {
  expect(CONFIG_TAIL).toBe('claude-code/mods/tracker/config.json')
})

test('the override names the whole folder', async () => {
  const r = await resolveConfigPath(envOf({ CLAUDE_TRACKER_CONFIG_DIR: '/t/cfg', XDG_CONFIG_HOME: '/x', HOME: '/h' }))
  expect(r).toEqual({ path: '/t/cfg/config.json', problems: [] })
})

test('a trailing slash gives one slash', async () => {
  const r = await resolveConfigPath(envOf({ CLAUDE_TRACKER_CONFIG_DIR: '/t/cfg/' }))
  expect(r.path).toBe('/t/cfg/config.json')
  const many = await resolveConfigPath(envOf({ CLAUDE_TRACKER_CONFIG_DIR: '/t/cfg///' }))
  expect(many.path).toBe('/t/cfg/config.json')
})

test('a relative override is ignored with one problem', async () => {
  const r = await resolveConfigPath(envOf({ CLAUDE_TRACKER_CONFIG_DIR: '~/cfg', HOME: '/h' }))
  expect(r.path).toBe(HOME_PATH)
  expect(r.problems).toEqual(['CLAUDE_TRACKER_CONFIG_DIR is not an absolute path: "~/cfg". The mod ignores it.'])
})

test('a relative override falls through to XDG_CONFIG_HOME', async () => {
  const r = await resolveConfigPath(envOf({ CLAUDE_TRACKER_CONFIG_DIR: 'rel', XDG_CONFIG_HOME: '/x', HOME: '/h' }))
  expect(r.path).toBe('/x/claude-code/mods/tracker/config.json')
  expect(r.problems).toHaveLength(1)
})

test('an empty override is unset and gives no problem', async () => {
  const r = await resolveConfigPath(envOf({ CLAUDE_TRACKER_CONFIG_DIR: '', HOME: '/h' }))
  expect(r).toEqual({ path: HOME_PATH, problems: [] })
})

test('an absolute XDG_CONFIG_HOME is the base', async () => {
  const r = await resolveConfigPath(envOf({ XDG_CONFIG_HOME: '/x', HOME: '/h' }))
  expect(r).toEqual({ path: '/x/claude-code/mods/tracker/config.json', problems: [] })
})

test('an empty or relative XDG_CONFIG_HOME is ignored with no problem', async () => {
  for (const xdg of ['', 'rel']) {
    const r = await resolveConfigPath(envOf({ XDG_CONFIG_HOME: xdg, HOME: '/h' }))
    expect(r).toEqual({ path: HOME_PATH, problems: [] })
  }
})

test('HOME alone gives the .config path, and a trailing slash does not double', async () => {
  expect(await resolveConfigPath(envOf({ HOME: '/h' }))).toEqual({ path: HOME_PATH, problems: [] })
  expect((await resolveConfigPath(envOf({ HOME: '/h/' }))).path).toBe(HOME_PATH)
})

test('no HOME and no override: no path and no problem', async () => {
  expect(await resolveConfigPath(envOf({}))).toEqual({ path: undefined, problems: [] })
})

test('a relative HOME counts as unset', async () => {
  expect(await resolveConfigPath(envOf({ HOME: 'home/u' }))).toEqual({ path: undefined, problems: [] })
})

test('an env read that rejects counts as unset', async () => {
  const env = {
    get: async (name: EnvName): Promise<string | undefined> => {
      if (name === 'CLAUDE_TRACKER_CONFIG_DIR') throw new Error('denied')
      return name === 'HOME' ? '/h' : undefined
    },
  }
  expect(await resolveConfigPath(env)).toEqual({ path: HOME_PATH, problems: [] })
  const denied = { get: async (): Promise<string | undefined> => Promise.reject(new Error('denied')) }
  expect(await resolveConfigPath(denied)).toEqual({ path: undefined, problems: [] })
})

test('each name is read at most once', async () => {
  const seen: string[] = []
  const env = {
    get: async (name: EnvName): Promise<string | undefined> => {
      seen.push(name)
      return name === 'HOME' ? '/h' : undefined
    },
  }
  await resolveConfigPath(env)
  expect(seen).toEqual(['CLAUDE_TRACKER_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOME'])
})

// ---------------------------------------------------------------- the default place of the debug log (issue #144)

test('the debug log is debug/latest in the Claude config folder: CLAUDE_CONFIG_DIR, else ~/.claude', async () => {
  expect(await resolveDebugLog(envOf({ CLAUDE_CONFIG_DIR: '/c', HOME: '/h' }))).toBe('/c/debug/latest')
  expect(await resolveDebugLog(envOf({ CLAUDE_CONFIG_DIR: '/c///' }))).toBe('/c/debug/latest')
  expect(await resolveDebugLog(envOf({ HOME: '/h' }))).toBe('/h/.claude/debug/latest')
  expect(await resolveDebugLog(envOf({ HOME: '/h/' }))).toBe('/h/.claude/debug/latest')
})

test('a relative or empty CLAUDE_CONFIG_DIR falls through to HOME', async () => {
  expect(await resolveDebugLog(envOf({ CLAUDE_CONFIG_DIR: 'rel', HOME: '/h' }))).toBe('/h/.claude/debug/latest')
  expect(await resolveDebugLog(envOf({ CLAUDE_CONFIG_DIR: '', HOME: '/h' }))).toBe('/h/.claude/debug/latest')
})

test('the debug log has no place without an absolute folder', async () => {
  expect(await resolveDebugLog(envOf({}))).toBeUndefined()
  expect(await resolveDebugLog(envOf({ HOME: 'home/u', CLAUDE_CONFIG_DIR: 'rel' }))).toBeUndefined()
})

test('an env read that rejects counts as unset for the debug log', async () => {
  const env = {
    get: async (name: EnvName): Promise<string | undefined> => {
      if (name === 'CLAUDE_CONFIG_DIR') throw new Error('denied')
      return name === 'HOME' ? '/h' : undefined
    },
  }
  expect(await resolveDebugLog(env)).toBe('/h/.claude/debug/latest')
  const denied = { get: async (): Promise<string | undefined> => Promise.reject(new Error('denied')) }
  expect(await resolveDebugLog(denied)).toBeUndefined()
})

test('the debug log reads CLAUDE_CONFIG_DIR and HOME and no other name', async () => {
  const seen: string[] = []
  const env = {
    get: async (name: EnvName): Promise<string | undefined> => {
      seen.push(name)
      return undefined
    },
  }
  await resolveDebugLog(env)
  expect(seen).toEqual(['CLAUDE_CONFIG_DIR', 'HOME'])
})
