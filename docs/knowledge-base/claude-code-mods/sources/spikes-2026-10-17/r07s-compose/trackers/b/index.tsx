import type { On } from 'claude-code'

/** Registered second: beneath A. Its next(e) is the tree beneath it (the engine's own, or nothing). */
export function installB(on: On): void {
  on('ui.render', { component: 'Pane', requestId: 'x' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const inner = await next(e)
    return (
      <Box key="b-root" flexDirection="column">
        <Text>{`B-body; e.props.title=${String((e.props as { title?: string }).title)}; next(e) typeof=${typeof inner}; sees: ${JSON.stringify(inner).slice(0, 120)}`}</Text>
        {inner as never}
      </Box>
    )
  })
}
