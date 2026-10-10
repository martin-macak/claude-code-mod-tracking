// The band above the prompt: one line with the counts. No `$` here.
import type { RenderElement } from 'claude-code'
import type { PaneElements } from './pane'

export function renderBand(el: PaneElements, text: string): RenderElement {
  const { Box, Text } = el
  return (
    <Box columnGap={1}>
      <Text dimColor>tracking</Text>
      <Text>{text}</Text>
      <Text dimColor>/track</Text>
    </Box>
  )
}
