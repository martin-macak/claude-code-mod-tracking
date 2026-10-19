import type { On } from 'claude-code'

export function installA(on: On): void {
  on('ui.render', { component: 'Pane', requestId: 'p' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const inner = await next(e)
    return (
      <Box key="a-root" flexDirection="column">
        <Text key="a-head">A-head</Text>
        {inner as never}
        <Text key="a-foot">A-foot</Text>
      </Box>
    )
  })
}
