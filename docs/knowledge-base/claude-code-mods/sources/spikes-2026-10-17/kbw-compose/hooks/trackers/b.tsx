import type { On } from 'claude-code'

export function installB(on: On): void {
  on('ui.render', { component: 'Pane', requestId: 'p' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="b-root" flexDirection="column">
        <Text key="b-body">B-body</Text>
      </Box>
    )
  })
}
