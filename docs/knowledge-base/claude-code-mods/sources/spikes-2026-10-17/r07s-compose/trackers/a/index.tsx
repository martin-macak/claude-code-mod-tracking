import type { On } from 'claude-code'

/** Registered first: outermost. Wraps whatever next(e) returns. title NOCALL: answers without next. title REWRITE: passes a rewritten title down. */
export function installA(on: On): void {
  on('ui.render', { component: 'Pane', requestId: 'x' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const title = String((e.props as { title?: string }).title)
    if (title === 'NOCALL') return <Box key="a-root"><Text>A-only (no next)</Text></Box>
    const inner = await next(title === 'REWRITE' ? { ...e, props: { ...e.props, title: 'rewritten-by-A' } } : e)
    return (
      <Box key="a-root" flexDirection="column">
        <Text>{`A-head; next(e) typeof=${typeof inner}; sees: ${JSON.stringify(inner).slice(0, 160)}`}</Text>
        {inner as never}
        <Text>A-foot</Text>
      </Box>
    )
  })
}
