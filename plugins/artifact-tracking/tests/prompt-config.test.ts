// The `prompt` config keys: PROMPT_RULE, promptSettings, the five trackers that carry the block and the merge that
// writes it into a file from before L7. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.11. Plan: L7 Task 2 (S3, C1).
import { expect, test } from 'claude-code/testing'
import { ConfigManager } from '../core/infra/config-manager'
import type { ConfigSpec } from '../core/interfaces/config'
import type { JsonObject } from '../core/interfaces/items'
import type { EnvName } from '../core/interfaces/ports'
import { PROMPT_RULE, promptSettings } from '../core/lib/prompt-config'
import { ARTIFACT_DEFAULTS } from '../trackers/artifact/config'
import { AUTO_DEFAULTS } from '../trackers/auto/config'
import { FILE_DEFAULTS } from '../trackers/file/config'
import { GITHUB_DEFAULTS, githubConfig } from '../trackers/github/config'
import { JIRA_DEFAULTS, jiraConfig } from '../trackers/jira/config'
import { PROCESSES_DEFAULTS } from '../trackers/processes/config'
import { REPOS_DEFAULTS, reposConfig } from '../trackers/repos/config'
import { WEB_DEFAULTS, webConfig } from '../trackers/web/config'
import { fakeConfigFs } from './fixtures/config-fs'

const OFF = { enabled: false, maxItems: 20 }

/** Runs a spec over a raw slice and collects the problem lines. */
function norm<C extends JsonObject>(spec: ConfigSpec<C>, raw: JsonObject): { value: Readonly<C>; out: string[] } {
  const out: string[] = []
  const value = spec.normalise(raw, spec.defaults, w => void out.push(w))
  return { value, out }
}

test('PROMPT_RULE defaults are enabled false and maxItems 20', () => {
  expect(GITHUB_DEFAULTS.prompt).toEqual(OFF)
  expect(PROMPT_RULE.kind).toBe('obj')
})

test('the five item trackers carry prompt keys and the other three do not', () => {
  for (const defaults of [GITHUB_DEFAULTS, JIRA_DEFAULTS, WEB_DEFAULTS, ARTIFACT_DEFAULTS, FILE_DEFAULTS]) {
    expect(defaults.prompt).toEqual(OFF)
    expect(Object.keys(defaults).at(-1)).toBe('prompt')
  }
  for (const defaults of [REPOS_DEFAULTS, PROCESSES_DEFAULTS, AUTO_DEFAULTS]) expect('prompt' in defaults).toBe(false)
})

test('maxItems 500 clamps to 50 with one problem', () => {
  const high = norm(githubConfig, { prompt: { maxItems: 500 } })
  expect(high.value.prompt.maxItems).toBe(50)
  expect(high.out).toEqual(['prompt.maxItems: 500 is above the max 50. Using 50.'])
  const low = norm(githubConfig, { prompt: { maxItems: 2 } })
  expect(low.value.prompt.maxItems).toBe(5)
  expect(low.out).toEqual(['prompt.maxItems: 2 is below the min 5. Using 5.'])
})

test('prompt: true is not an object', () => {
  const got = norm(jiraConfig, { prompt: true })
  expect(got.value.prompt).toEqual(OFF)
  expect(got.out).toEqual(['prompt: true is not an object. Using the defaults.'])
})

test('prompt.enabled: "yes" falls back to false', () => {
  const got = norm(webConfig, { prompt: { enabled: 'yes' } })
  expect(got.value.prompt).toEqual(OFF)
  expect(got.out).toEqual(['prompt.enabled: "yes" is not true or false. Using false.'])
})

test('a valid prompt block passes with no problem and an unknown key inside it is named', () => {
  const ok = norm(githubConfig, { prompt: { enabled: true, maxItems: 7 } })
  expect(ok.value.prompt).toEqual({ enabled: true, maxItems: 7 })
  expect(ok.out).toEqual([])
  const typo = norm(githubConfig, { prompt: { enabled: true, maxItem: 7 } })
  expect(typo.out).toEqual(['prompt.maxItem: unknown key. The mod keeps it and ignores it.'])
})

test('promptSettings reads a normalised slice', () => {
  expect(promptSettings({ prompt: { enabled: true, maxItems: 7 } })).toEqual({ enabled: true, maxItems: 7 })
})

test('promptSettings of a slice with no prompt key is off with 20', () => {
  expect(promptSettings({})).toEqual(OFF)
})

test('promptSettings does not trust a stale slice', () => {
  expect(promptSettings({ prompt: { enabled: 'true', maxItems: '9' } })).toEqual(OFF)
  expect(promptSettings({ prompt: { enabled: true, maxItems: 500 } })).toEqual({ enabled: true, maxItems: 50 })
  expect(promptSettings({ prompt: { enabled: true, maxItems: 1 } })).toEqual({ enabled: true, maxItems: 5 })
  expect(promptSettings({ prompt: { enabled: true, maxItems: 7.5 } })).toEqual({ enabled: true, maxItems: 20 })
  expect(promptSettings({ prompt: { enabled: true, maxItems: Number.NaN } })).toEqual({ enabled: true, maxItems: 20 })
  expect(promptSettings({ prompt: { enabled: 1, maxItems: Number.POSITIVE_INFINITY } })).toEqual(OFF)
  expect(promptSettings({ prompt: [] })).toEqual(OFF)
  expect(promptSettings({ prompt: null })).toEqual(OFF)
})

const P = '/h/.config/claude-code/mods/tracker/config.json'
const MERGE_STORED: ReadonlyMap<string, JsonObject> = new Map<string, JsonObject>([
  ['github', GITHUB_DEFAULTS],
  ['web', WEB_DEFAULTS],
  ['repos', REPOS_DEFAULTS],
])

/** A manager over the three real specs and one file on the fake fs. */
function over(file: string) {
  const fake = fakeConfigFs({ [P]: file })
  const manager = new ConfigManager({
    fs: fake.fs,
    env: { get: async (name: EnvName) => (name === 'HOME' ? '/h' : undefined) },
    specs: [
      { id: 'github', config: githubConfig },
      { id: 'web', config: webConfig },
      { id: 'repos', config: reposConfig },
    ],
    log: () => {},
  })
  return { fake, manager }
}

const trackersOf = (text: string | undefined): Record<string, JsonObject> =>
  (JSON.parse(text ?? 'null') as { trackers: Record<string, JsonObject> }).trackers

test('a 0.1.x file gains the prompt keys and keeps user values', async () => {
  const { fake, manager } = over(
    '{"version":1,"trackers":{"github":{"enabled":true,"chunkSize":10},"web":{"enabled":false}}}',
  )
  await manager.refresh()
  await manager.reconcile(MERGE_STORED)
  expect(fake.writes).toHaveLength(1)
  const trackers = trackersOf(fake.files.get(P))
  expect(trackers.github?.chunkSize).toBe(10)
  expect(trackers.github?.prompt).toEqual(OFF)
  expect(trackers.web).toEqual({ enabled: false, prompt: OFF })
  expect('prompt' in (trackers.repos ?? {})).toBe(false)
})

test("a user's prompt.enabled survives the merge", async () => {
  const { fake, manager } = over('{"version":1,"trackers":{"github":{"prompt":{"enabled":true}}}}')
  await manager.refresh()
  await manager.reconcile(MERGE_STORED)
  expect(trackersOf(fake.files.get(P)).github?.prompt).toEqual({ enabled: true, maxItems: 20 })
})
