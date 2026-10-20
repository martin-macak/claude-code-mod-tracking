// The band above the prompt: the line from the sections that carry a band part, and its drawing (plan L6 Task 9, G17).
import { expect, test } from 'claude-code/testing'
import type { SectionSpec } from '../core/interfaces/view'
import { bandText, renderBand } from '../ux/band'
import { EL } from './fixtures/elements'
import { COLS, section } from './fixtures/sections'

const part = (label: string, count: number, failing = 0): SectionSpec =>
  section(label.toLowerCase(), COLS, [], { band: { label, count, failing } })

interface Node {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}
const asNode = (n: unknown) => n as Node

test('bandText joins label and count with · and adds (n ✗) when failing', () => {
  expect(bandText([part('Jira', 6), part('GitHub', 4, 1), part('Links', 2)])).toBe('Jira 6 · GitHub 4 (1 ✗) · Links 2')
})

const conflicted = (label: string, count: number, failing: number, conflicts: number): SectionSpec =>
  section(label.toLowerCase(), COLS, [], { band: { label, count, failing, conflicts } })

test('AC7: bandText puts the conflicts next to the ✗ count: PRs 3 (1 ✗ · 2 conflicts)', () => {
  expect(bandText([conflicted('PRs', 3, 1, 2)])).toBe('PRs 3 (1 ✗ · 2 conflicts)')
})

test('bandText: conflicts alone read (n conflicts); a zero or absent count adds nothing', () => {
  expect(bandText([conflicted('PRs', 2, 0, 2)])).toBe('PRs 2 (2 conflicts)')
  expect(bandText([conflicted('PRs', 2, 1, 0)])).toBe('PRs 2 (1 ✗)')
  expect(bandText([conflicted('PRs', 2, 0, 0)])).toBe('PRs 2')
  expect(bandText([conflicted('PRs', 1, 0, 1), part('Jira', 6)])).toBe('PRs 1 (1 conflict) · Jira 6') // one reads singular
})

test('bandText leaves out a zero count and gives null when all are zero or none has a band', () => {
  expect(bandText([part('Jira', 0), part('Links', 2), part('Files', 0)])).toBe('Links 2')
  expect(bandText([part('Jira', 0), part('Links', 0)])).toBeNull()
  expect(bandText([section('web', COLS, [])])).toBeNull()
  expect(bandText([])).toBeNull()
})

test('renderBand draws tracking, the line and /track, then the engine band, in one column', () => {
  const engine = { type: 'Text', props: {}, children: ['engine band'] }
  const root = asNode(renderBand(EL, 'Jira 1', engine as never))
  expect(root.type).toBe('Box')
  expect(root.props).toEqual({ flexDirection: 'column' })
  expect(root.children).toHaveLength(2)
  const band = asNode(root.children[0])
  expect(band.type).toBe('Box')
  expect(band.props).toEqual({ columnGap: 1 })
  const texts = band.children.map(asNode)
  expect(texts.map(t => t.type)).toEqual(['Text', 'Text', 'Text'])
  expect(texts.map(t => t.children[0])).toEqual(['tracking', 'Jira 1', '/track'])
  expect(texts.map(t => t.props)).toEqual([
    { wrap: 'truncate-end', dimColor: true },
    { wrap: 'truncate-end' },
    { wrap: 'truncate-end', dimColor: true },
  ])
  expect(root.children[1]).toBe(engine)
})
