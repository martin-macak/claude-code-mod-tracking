import { expect, test } from 'claude-code/testing'
import { renderBand } from '../hooks/ui/band'
import type { PaneElements } from '../hooks/ui/pane'

test('band text parts all truncate to avoid wrapping in narrow columns', () => {
  const band = renderBand({ Box: 'Box', Text: 'Text' } as unknown as PaneElements, 'GitHub 3 · Links 1') as {
    children?: { type?: string; props?: { wrap?: string } }[]
  }
  const parts = (band.children ?? []).filter(c => c.type === 'Text')
  expect(parts).toHaveLength(3)
  expect(parts.map(p => p.props?.wrap)).toEqual(['truncate-end', 'truncate-end', 'truncate-end'])
})
