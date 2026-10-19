// R-REENTRY probe 4: a ui.render hook that calls $.ui.invalidate('ui.render') once per draw, capped.
import type { Register } from 'claude-code'

const CAPS: Record<string, number> = { p3: 3, p20: 20, p0: 0 }
const draws: Record<string, number> = {}

export const register: Register = on => {
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const id = String((e as { requestId?: string }).requestId ?? '?')
    const n = (draws[id] = (draws[id] ?? 0) + 1)
    const { Box, Text } = $.ui.resolve(e)
    const inner = await next(e)
    if (n <= (CAPS[id] ?? 0)) $.ui.invalidate('ui.render')
    return (
      <Box key="root" flexDirection="column">
        <Text key="n">{`draws=${n}`}</Text>
        {inner as never}
      </Box>
    )
  })
}
