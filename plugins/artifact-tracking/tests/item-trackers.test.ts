// The github, jira and web trackers: identity and config only in L3 (plan decision D13). The config rules are the
// ones the config file will use: a bad value falls back to the default and warns, unknown keys stay.
import { expect, test } from 'claude-code/testing'
import { LIMITS } from '../hooks/contracts'
import { githubConfig, githubTracker } from '../trackers/github'
import { CHUNK } from '../trackers/github/gh-tool'
import { jiraConfig, jiraTracker } from '../trackers/jira'
import { webConfig, webTracker } from '../trackers/web'
import { hostWorld } from './fixtures/tracker-host'

const warnings = () => {
  const list: string[] = []
  return { list, warn: (p: string) => void list.push(p) }
}

test('defaults serve today: github chunk 50, jira concurrency 3 and 50 epic children, web on', () => {
  expect(githubConfig.defaults).toEqual({ enabled: true, chunkSize: CHUNK })
  expect(jiraConfig.defaults).toEqual({
    enabled: true,
    concurrency: LIMITS.acliConcurrency,
    epicChildLimit: LIMITS.epicChildLimit,
  })
  expect(webConfig.defaults).toEqual({ enabled: true })
  expect(Object.isFrozen(githubConfig.defaults)).toBe(true)
})

test('the trackers take their ids and orders from the pane: jira 20, github 30, web 60', () => {
  expect([githubTracker(), jiraTracker(), webTracker()].map(t => [t.id, t.order])).toEqual([
    ['github', 30],
    ['jira', 20],
    ['web', 60],
  ])
})

test('a good slice is kept as it is, unknown keys too, and the result is frozen', () => {
  const w = warnings()
  const out = githubConfig.normalise({ enabled: false, chunkSize: 20, extra: 'x' }, githubConfig.defaults, w.warn)
  expect(out).toEqual({ enabled: false, chunkSize: 20, extra: 'x' })
  expect(Object.isFrozen(out)).toBe(true)
  expect(w.list).toEqual([])
})

test('a bad value falls back to the default with one warning each', () => {
  const w = warnings()
  expect(githubConfig.normalise({ enabled: 'yes', chunkSize: 0 }, githubConfig.defaults, w.warn)).toEqual({
    enabled: true,
    chunkSize: CHUNK,
  })
  expect(
    jiraConfig.normalise({ enabled: 1, concurrency: 99, epicChildLimit: 'many' }, jiraConfig.defaults, w.warn),
  ).toEqual(jiraConfig.defaults)
  expect(webConfig.normalise({ enabled: null }, webConfig.defaults, w.warn)).toEqual({ enabled: true })
  expect(w.list.length).toBe(6)
  expect(w.list[0]).toContain('github.enabled')
})

test('a jira number is rounded and kept inside its range', () => {
  const w = warnings()
  const out = jiraConfig.normalise({ concurrency: 4.4, epicChildLimit: 500 }, jiraConfig.defaults, w.warn)
  expect(out).toMatchObject({ concurrency: 4, epicChildLimit: 500 })
  expect(w.list).toEqual([])
})

test('each tracker stores its own slice and init does nothing', async () => {
  const list = [githubTracker(), jiraTracker(), webTracker()]
  const t = hostWorld(list)
  await t.host.init()
  expect(t.host.failed()).toEqual([])
  for (const tracker of list) expect(t.host.stored().get(tracker.id)).toEqual(tracker.config.defaults)
})
