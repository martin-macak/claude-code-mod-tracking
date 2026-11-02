// The Buttons of the body of the preview (issue #277, B6): the `↩ back` Button, the key line and the dim keys of the detail view.
// Pure. A letter with no Button would leave the pane for the prompt, so every key of the registry has a Button in the detail view.
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS, KeyRegistry } from '../core/infra/keys'
import { BACK_BUTTON, previewBody } from '../core/infra/preview-body'
import type { KeySpec } from '../core/interfaces/tracker'
import type { PaneKey } from '../core/interfaces/view'

const spec = (id: string, key: string): KeySpec => ({ id, key, label: id, scope: 'row' })
const modesOf = (...modes: Array<[id: string, enabled: boolean]>) => modes.map(([id, enabled]) => ({ id, enabled }))
const keysOf = (b: ReturnType<typeof previewBody>) => (b.dim ?? []).map(k => k.key)

function world() {
  const reg = new KeyRegistry()
  reg.add('github', [spec('resolve', 'c'), spec('files', 'f')])
  reg.add('web', [spec('go', 'w')])
  return reg
}

test('the dim keys: every key that the key line does not draw, dim and in registry order, then the keys of the owner of the row (B6)', () => {
  const reg = world()
  // A row with no file mode: the key line has `r` alone, so `v` and `d` are dim too (M1 of PR 302).
  const body = previewBody(reg, [], 'detail', 'github')
  expect(keysOf(body)).toEqual(['h', 'g', 'a', 't', 'p', 'm', 'e', 'x', '1', '2', '3', '0', 'o', 'v', 'd', 'c', 'f'])
  expect(body.dim?.every(k => k.enabled === false)).toBe(true)
  // The key line draws r itself, so it is not dim; and the tracker keys of another owner are not drawn.
  expect(keysOf(body).some(k => ['r', 'w'].includes(k))).toBe(false)
  for (const k of body.dim ?? []) expect(reg.get(k.buttonKey)?.key).toBe(k.key)
  // No owner: the core keys alone.
  expect(keysOf(previewBody(reg, [], 'detail', ''))).toEqual([
    'h',
    'g',
    'a',
    't',
    'p',
    'm',
    'e',
    'x',
    '1',
    '2',
    '3',
    '0',
    'o',
    'v',
    'd',
  ])
})

test('a row that lists the view only has a dim d; a row that lists both has no dim v or d (M1 of PR 302)', () => {
  const reg = world()
  const view = keysOf(previewBody(reg, modesOf(['view', true]), 'detail', 'github'))
  expect(view).toContain('d')
  expect(view).not.toContain('v')
  const both = keysOf(previewBody(reg, modesOf(['view', true], ['diff', true]), 'detail', 'github'))
  expect(both.some(k => k === 'v' || k === 'd')).toBe(false)
  // A mode that is listed but off draws dim on the key line and is not a second Button.
  const off = previewBody(reg, modesOf(['view', false]), 'detail', 'github')
  expect(keysOf(off)).not.toContain('v')
})

test('the dim keys read the registry, so a new core key gets its dim Button and no letter reaches the prompt (B6)', () => {
  const extra: PaneKey = { id: 'export', key: 'l', label: 'export', scope: 'pane', owner: 'core', bar: 'view' }
  const reg = new KeyRegistry([...CORE_KEYS, extra])
  expect(previewBody(reg, [], 'detail', 'x').dim?.at(-1)).toMatchObject({
    key: 'l',
    enabled: false,
    buttonKey: 'export',
  })
})

test('the Button keys: the back Button first, then the keys of the line, then the dim keys, each once: what the ring and the refocus compare', () => {
  const reg = new KeyRegistry()
  const body = previewBody(reg, modesOf(['view', true]), 'detail', 'web')
  const all = body.buttons
  expect(all[0]).toBe(BACK_BUTTON)
  expect(all.slice(1, 3)).toEqual(['preview', 'refresh'])
  expect(all.slice(3)).toEqual((body.dim ?? []).map(k => k.buttonKey))
  expect(new Set(all).size).toBe(all.length) // one Button key for each Button, or the refocus would pick the wrong one
})

test('a file mode draws the dim keys too, but no back Button: no core key leaks to the prompt (issue #300)', () => {
  const reg = world()
  const body = previewBody(reg, modesOf(['view', true], ['diff', true]), 'view', 'github')
  expect(body.keys.map(k => k.key)).toEqual(['v', 'd', 'r'])
  expect(keysOf(body)).toEqual(['h', 'g', 'a', 't', 'p', 'm', 'e', 'x', '1', '2', '3', '0', 'o', 'c', 'f'])
  expect(body.dim?.every(k => k.enabled === false)).toBe(true)
  expect(body.back).toBe(false)
  expect(body.buttons[0]).not.toBe(BACK_BUTTON)
  expect(body.buttons).toEqual([...body.keys, ...(body.dim ?? [])].map(k => k.buttonKey))
  // The detail view keeps its back Button.
  expect(previewBody(reg, [], 'detail', 'github').back).toBe(true)
})
