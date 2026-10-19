// Kit only: a module beside hooks/ (not a test file) reaches the engine's global `h`. Spec 7.1 rests on this.
import { expect, test } from 'claude-code/testing'
import { type TableElements, text } from '../ux/tree-data-table/el'

test('an imported ux module may call the global h', () => {
  const built = text({ Text: 'Text' } as unknown as TableElements, { wrap: 'truncate-end' }, 'a')
  expect(built.type).toBe('Text')
})
