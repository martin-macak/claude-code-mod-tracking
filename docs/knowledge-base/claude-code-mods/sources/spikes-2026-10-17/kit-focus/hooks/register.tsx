// Spike G04. A ui.focus hook writes the `selected` atom. The Pane render reads it and marks the row.
// A second Pane (requestId 'bad') has a render hook that tries to WRITE state: the negative control.
import type { Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

const selected = atom({ plugin: 'kit-focus', key: 'selected' } as const, null as string | null)
const log = atom({ plugin: 'kit-focus', key: 'log' } as const, [] as string[])

const ROWS = ['row-a', 'row-b', 'row-c']

export const register: Register = on => {
  // The write under test: a ui.focus hook (not a render hook) updates the atom.
  on('ui.focus', { requestId: 'p' }, async ($, e, next) => {
    await update($, selected, () => e.element ?? null)
    await update($, log, l => [...l, `focus:${e.element ?? 'none'}:${e.origin.kind}`])
    return next(e)
  })

  // Variant: write AFTER the ring moved, and only when the engine did not deny it.
  on('ui.focus', { requestId: 'q' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined) await update($, selected, () => e.element ?? null)
    return r
  })

  // Reads the atom while drawing: this `get` subscribes the instance to later sets.
  on('ui.render', { component: 'Pane', requestId: 'p' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const sel = await read($, selected)
    return (
      <Box flexDirection="column">
        {ROWS.map(id => (
          <Box key={`box-${id}`} flexDirection="row" backgroundColor={sel === id ? 'blue' : undefined}>
            <Text>{sel === id ? '> ' : '  '}</Text>
            <Button key={id} label={id} onPress={() => {}} />
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'q' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const sel = await read($, selected)
    return (
      <Box flexDirection="column">
        {ROWS.map(id => (
          <Box key={`box-${id}`} flexDirection="row" backgroundColor={sel === id ? 'blue' : undefined}>
            <Text>{sel === id ? '> ' : '  '}</Text>
            <Button key={id} label={id} onPress={() => {}} />
          </Box>
        ))}
      </Box>
    )
  })

  // Negative control: a render hook writes state. The engine should refuse; the hook catches and draws the message.
  on('ui.render', { component: 'Pane', requestId: 'bad' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    let msg = 'write-ok'
    try {
      await update($, selected, () => 'written-in-render')
    } catch (err) {
      msg = 'write-refused: ' + String((err as Error).message)
    }
    return (
      <Box>
        <Text>{msg}</Text>
      </Box>
    )
  })
}
