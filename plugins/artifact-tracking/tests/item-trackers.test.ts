// The github, jira and web trackers: identity and config only in L3 (plan decision D13). The config rules are the
// ones the config file will use: a bad value falls back to the default and warns, unknown keys stay.
import { expect, test } from 'claude-code/testing'
import { githubConfig, githubTracker } from '../trackers/github'
import { jiraConfig, jiraTracker } from '../trackers/jira'
import { webConfig, webTracker } from '../trackers/web'
import { LIMITS } from './fixtures/limits'
import { hostWorld } from './fixtures/tracker-host'

const warnings = () => {
  const list: string[] = []
  return { list, warn: (p: string) => void list.push(p) }
}

test('defaults serve today: github chunk 50, jira concurrency 3 and 50 epic children, web on', () => {
  expect(githubConfig.defaults).toMatchObject({ enabled: true, chunkSize: 50 })
  expect(jiraConfig.defaults).toEqual({
    enabled: true,
    concurrency: LIMITS.acliConcurrency,
    epicChildLimit: LIMITS.epicChildLimit,
    prompt: { enabled: false, maxItems: 20 },
  })
  expect(webConfig.defaults).toEqual({ enabled: true, prompt: { enabled: false, maxItems: 20 } })
  expect(Object.isFrozen(githubConfig.defaults)).toBe(true)
})

test('the trackers take their ids and orders from the pane: jira 20, github 30, web 60', () => {
  expect([githubTracker(), jiraTracker(), webTracker()].map(t => [t.id, t.order])).toEqual([
    ['github', 30],
    ['jira', 20],
    ['web', 60],
  ])
})

test('a good slice is kept as it is, unknown keys too, and a typo is named', () => {
  const w = warnings()
  const out = githubConfig.normalise({ enabled: false, chunkSize: 20, extra: 'x' }, githubConfig.defaults, w.warn)
  expect(out).toMatchObject({ enabled: false, chunkSize: 20, extra: 'x' })
  expect(w.list).toEqual(['extra: unknown key. The mod keeps it and ignores it.'])
})

test('a bad value falls back to the default or the nearest bound with one warning each', () => {
  const w = warnings()
  expect(githubConfig.normalise({ enabled: 'yes', chunkSize: 0 }, githubConfig.defaults, w.warn)).toMatchObject({
    enabled: true,
    chunkSize: 1,
  })
  expect(
    jiraConfig.normalise({ enabled: 1, concurrency: 99, epicChildLimit: 'many' }, jiraConfig.defaults, w.warn),
  ).toEqual({ ...jiraConfig.defaults, concurrency: 10 })
  expect(webConfig.normalise({ enabled: null }, webConfig.defaults, w.warn)).toEqual(webConfig.defaults)
  expect(w.list.length).toBe(6)
  expect(w.list[0]).toBe('enabled: "yes" is not true or false. Using true.')
})

test('a jira number is kept inside its range; a decimal takes the default', () => {
  const w = warnings()
  const out = jiraConfig.normalise({ concurrency: 4, epicChildLimit: 500 }, jiraConfig.defaults, w.warn)
  expect(out).toMatchObject({ concurrency: 4, epicChildLimit: 500 })
  expect(w.list).toEqual([])
  expect(jiraConfig.normalise({ concurrency: 4.4 }, jiraConfig.defaults, w.warn).concurrency).toBe(3)
  expect(w.list).toEqual(['concurrency: 4.4 is not a whole number. Using 3.'])
})

test('each tracker stores its own slice and init does nothing', async () => {
  const list = [githubTracker(), jiraTracker(), webTracker()]
  const t = hostWorld(list)
  await t.host.init()
  expect(t.host.failed()).toEqual([])
  for (const tracker of list) expect(t.host.stored().get(tracker.id)).toEqual(tracker.config.defaults)
})
