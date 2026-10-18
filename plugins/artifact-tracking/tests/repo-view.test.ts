import { expect, test } from 'claude-code/testing'
import type { RepoRecord } from '../hooks/contracts'
import { isRowId, repoRowId } from '../hooks/contracts'
import { repoBandPart, repoSection } from '../trackers/repos/view'

const repo = (key: string, over: Partial<RepoRecord> = {}): RepoRecord => ({
  key,
  name: key.split('/').slice(-2).join('/'),
  branch: 'main',
  touchedBy: ['main'],
  firstSeen: 1,
  lastSeen: 1,
  ...over,
})

test('repoSection is null for no rows', () => {
  expect(repoSection([])).toBeNull()
})

test('repoSection sorts rows by firstSeen and fills key, title and type', () => {
  const late = repo('remote:github.com/acme/late', { firstSeen: 9, branch: 'dev' })
  const early = repo('remote:github.com/acme/sdk', { firstSeen: 2, touchedBy: ['main', 'planner'] })
  const section = repoSection([late, early])
  expect(section?.rows.map(r => r.key)).toEqual(['acme/sdk', 'acme/late'])
  expect(section?.rows[0]).toMatchObject({ title: 'main', type: 'main, planner' })
  expect(section?.rows[1]?.title).toBe('dev')
})

test('repoSection: a row with no branch has an empty title', () => {
  const section = repoSection([repo('remote:github.com/acme/sdk', { branch: undefined })])
  expect(section?.rows[0]?.title).toBe('')
})

test('repoSection: rows carry the dismiss id, the section is dismissable and uses the repos layout', () => {
  const key = 'remote:github.com/acme/sdk'
  const section = repoSection([repo(key)])
  expect(section).toMatchObject({ id: 'repos', title: 'Repos', note: '1 tracked', layout: 'repos', dismissable: true })
  expect(section?.rows[0]).toMatchObject({ id: 'rp:' + key, dismissId: 'rp:' + key, status: 'read' })
})

test('repoSection: a row shows edit or read, and a row without mode reads as read', () => {
  const section = repoSection([
    repo('remote:github.com/acme/a', { firstSeen: 1, mode: 'edit' }),
    repo('remote:github.com/acme/b', { firstSeen: 2, mode: 'read' }),
    repo('remote:github.com/acme/c', { firstSeen: 3 }),
  ])
  expect(section?.rows.map(r => [r.status, r.tone])).toEqual([
    ['edit', 'ok'],
    ['read', 'dim'],
    ['read', 'dim'],
  ])
})

test('repoBandPart prints the count, and null for no rows', () => {
  expect(repoBandPart([repo('remote:github.com/a/b'), repo('remote:github.com/a/c')])).toBe('Repos 2')
  expect(repoBandPart([])).toBeNull()
})

test('repoRowId and isRowId: a repo row id is a row id, an item key is not', () => {
  expect(repoRowId('local:/x')).toBe('rp:local:/x')
  expect(isRowId('rp:local:/x')).toBe(true)
  expect(isRowId('remote:github.com/a/b')).toBe(false)
})
