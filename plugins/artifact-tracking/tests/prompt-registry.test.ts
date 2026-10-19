// Which trackers define prompt(): the five that list items, and only those. Their config carries the prompt keys.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.11. Plan: L7 Task 5 (S3).
import { expect, test } from 'claude-code/testing'
import { TRACKERS } from '../trackers'

const ITEM_TRACKERS = ['artifact', 'file', 'github', 'jira', 'web']

test('exactly github, jira, web, artifact and file define prompt', () => {
  const ids = TRACKERS.filter(t => t.prompt).map(t => t.id)
  expect(ids.sort()).toEqual(ITEM_TRACKERS)
})

test('each tracker with prompt has the keys, the others do not', () => {
  for (const t of TRACKERS) {
    const defines = typeof t.prompt === 'function'
    expect('prompt' in t.config.defaults).toBe(defines)
    if (defines) expect(t.config.defaults.prompt).toEqual({ enabled: false, maxItems: 20 })
  }
  expect(TRACKERS.filter(t => 'prompt' in t.config.defaults).map(t => t.id)).toEqual(
    TRACKERS.filter(t => t.prompt).map(t => t.id),
  )
})
