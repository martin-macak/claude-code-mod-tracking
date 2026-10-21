// The band above the prompt: the line from the sections that carry a band part, and its drawing (plan L6 Task 9, G17).
import { expect, test } from 'claude-code/testing'
import type { SectionSpec } from '../core/interfaces/view'
import { bandText, renderBand } from '../ux/band'
import { EL } from './fixtures/elements'
import { section } from './fixtures/sections'

const part = (label: string, count: number, failing = 0): SectionSpec =>
  section(label.toLowerCase(), [], { band: { label, count, failing } })

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
  section(label.toLowerCase(), [], { band: { label, count, failing, conflicts } })

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
  expect(bandText([section('web', [])])).toBeNull()
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

// ---------------------------------------------------------------- the turn part (issue #69)

const engineBand = { type: 'Text', props: {}, children: ['engine band'] }

test('R10: the band draws the turn part and its Button between the line and /track', () => {
  const pressed: string[] = []
  const turn = { ord: 7, text: '+3 new · 1 seen again', press: () => void pressed.push('open') }
  const root = asNode(renderBand(EL, 'Links 2 · Repos 1', engineBand as never, turn))
  const band = asNode(root.children[0])
  const parts = band.children.map(asNode)
  expect(parts.map(p => p.type)).toEqual(['Text', 'Text', 'Text', 'Button', 'Text'])
  expect(parts.map(p => p.children[0])).toEqual([
    'tracking',
    'Links 2 · Repos 1',
    'turn 7 +3 new · 1 seen again',
    undefined,
    '/track',
  ])
  const button = parts[3]!
  expect(button.props).toMatchObject({ key: 'turn-open', plain: true, hotkey: '9', label: 'open' })
  ;(button.props.onPress as () => void)()
  expect(pressed).toEqual(['open'])
  expect(root.children[1]).toBe(engineBand)
})

test('R10: with no section part the band still shows the turn part; with neither it is the plain band', () => {
  const turn = { ord: 2, text: '1 seen again', press: () => {} }
  const only = asNode(asNode(renderBand(EL, null, engineBand as never, turn)).children[0])
  expect(only.children.map(asNode).map(p => p.children[0])).toEqual([
    'tracking',
    'turn 2 1 seen again',
    undefined,
    '/track',
  ])
  const plain = asNode(asNode(renderBand(EL, 'Jira 1', engineBand as never)).children[0])
  expect(plain.children.map(asNode).map(p => p.children[0])).toEqual(['tracking', 'Jira 1', '/track'])
})

test('R10: a turn part with no press shows its words and draws no Button, so the band is no stop of ctrl+x Tab', () => {
  const band = asNode(asNode(renderBand(EL, 'Links 1', engineBand as never, { ord: 4, text: '+1 new' })).children[0])
  const parts = band.children.map(asNode)
  expect(parts.map(p => p.type)).toEqual(['Text', 'Text', 'Text', 'Text'])
  expect(parts.map(p => p.children[0])).toEqual(['tracking', 'Links 1', 'turn 4 +1 new', '/track'])
})
