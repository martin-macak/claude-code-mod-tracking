// The GitHub side of the auto tracker's PR lane, over the item host: it fails with `not ready` before the start, serves the
// tool and the repo after it, and reads the lane values of the github slice at each call. It moved out of the item runtime
// with the L5 split. Plan: L5 Task 8, L3 D13.
import { expect, test } from 'claude-code/testing'
import { autoGithubOf } from '../hooks/auto-github'
import type { GitHubTarget } from '../hooks/contracts'
import { GITHUB_DEFAULTS } from '../trackers/github/config'
import { managerWorld } from './fixtures/manager'

test('the autoGithub facet rejects before start', async () => {
  const t = managerWorld()
  const gh = t.autoGithub
  expect(gh.hosts()).toEqual([])
  expect(gh.discovery.isAvailable).toBe(false)
  expect(gh.discovery.name).toBe('gh')
  await expect(gh.ready()).rejects.toThrow('gh: not ready')
  await expect(gh.repo()).rejects.toThrow('gh: not ready')
  expect(() => gh.discovery.status()).toThrow('gh: not ready')
  expect(() => gh.discovery.reset()).toThrow('gh: not ready')
  expect(() => gh.discovery.canCall(0)).toThrow('gh: not ready')
})

test('the autoGithub facet serves the tool and the repo after start', async () => {
  const t = managerWorld()
  await t.m.ensureStarted(t.w.ports)
  await t.rt.settle()
  const gh = t.autoGithub
  expect(await gh.ready()).toBe(true)
  expect(gh.discovery.isAvailable).toBe(true)
  expect(await gh.repo()).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(gh.hosts()).toEqual([])
  expect(gh.discovery.canCall(0)).toBe(true)
  expect(gh.discovery.status().name).toBe('gh')
  expect(await gh.discovery.checkHost('github.com')).toBe(true)
  expect(gh.discovery.isHostAuthed('github.com')).toBe(true)
  expect((await gh.discovery.defaultRepo())?.repo).toBe('web')
  const target: GitHubTarget = {
    key: 'gh:github.com/acme/web#5',
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number: 5,
    type: 'unknown',
  }
  await gh.discovery.refreshItems([target])
  expect(target.state).toBe('open')
  expect(await gh.discovery.graphql('github.com', '{ viewer { login } }')).toBeDefined()
  gh.discovery.reset()
})

test('the lane values come from the github slice at each call, over the defaults', async () => {
  const none = autoGithubOf({ manager: () => undefined, now: () => 0 })
  const { headPrsPerBranch, basePrsPerBranch, closingRefsPerPr, maxBodyRefs } = GITHUB_DEFAULTS
  expect(none.lane()).toEqual({ headPrsPerBranch, basePrsPerBranch, closingRefsPerPr, maxBodyRefs })
  const t = managerWorld()
  await t.m.ensureStarted(t.w.ports)
  expect(t.autoGithub.lane().headPrsPerBranch).toBe(headPrsPerBranch)
  ;(t.cfg as unknown as { set(file: object): void }).set({ trackers: { github: { headPrsPerBranch: 7 } } }) // a changed file
  expect(t.autoGithub.lane().headPrsPerBranch).toBe(7)
})
