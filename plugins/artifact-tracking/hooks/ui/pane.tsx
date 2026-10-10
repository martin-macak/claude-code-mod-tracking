// The /track pane: a tree table drawn from PaneSection[]. No `$` here: register.tsx passes the element table.
// Layout follows the live probe (KB mod-api-notes section 6): fixed-width cells, a growing title, columnGap 1.
import type { Color, Elements, RenderElement } from 'claude-code'
import type { Columns, PaneRow, PaneSection, Tone } from './view'

/** The four tags the pane uses. Every surface table holds them, so `$.ui.resolve(e)` fits. */
export type PaneElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

export type PaneActions = { fold(id: string): void; refresh(): void }

const TONE_COLOR: Partial<Record<Tone, Color>> = { ok: 'green', warn: 'yellow', bad: 'red' }

/** Text props for a tone: a colour, dim, or nothing. */
function toneProps(tone: Tone | undefined): { color?: Color; dimColor?: boolean } {
  if (tone === 'dim') return { dimColor: true }
  const color = tone ? TONE_COLOR[tone] : undefined
  return color ? { color } : {}
}

function Row(el: PaneElements, row: PaneRow, cols: Columns, actions: PaneActions): RenderElement {
  const { Box, Text, Button, Link } = el
  return (
    <Box key={'row-' + row.id} columnGap={1}>
      <Box width={cols.key} flexShrink={0} paddingLeft={row.depth * 2}>
        <Box width={2} flexShrink={0}>
          {row.foldable ? (
            <Button key={'fold-' + row.id} plain label={row.folded ? '+' : '-'} onPress={() => actions.fold(row.id)} />
          ) : (
            <Text> </Text>
          )}
        </Box>
        <Text wrap="truncate-end">{row.href ? <Link href={row.href}>{row.key}</Link> : row.key}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{row.title}</Text>
      </Box>
      <Box width={cols.type} flexShrink={0}>
        <Text wrap="truncate-end">{row.type}</Text>
      </Box>
      <Box width={cols.status} flexShrink={0}>
        <Text wrap="truncate-end" {...toneProps(row.tone)}>
          {row.status}
        </Text>
      </Box>
      {cols.extra > 0 ? (
        <Box width={cols.extra} flexShrink={0}>
          <Text wrap="truncate-end" {...toneProps(row.extraTone)}>
            {row.extra ?? ''}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

function Section(el: PaneElements, section: PaneSection, cols: Columns, actions: PaneActions): RenderElement {
  const { Box, Text } = el
  return (
    <Box key={'section-' + section.category} flexDirection="column">
      <Box columnGap={1}>
        <Text bold>{section.title}</Text>
        <Text dimColor>{section.note}</Text>
      </Box>
      {section.rows.map(row => Row(el, row, cols, actions))}
    </Box>
  )
}

export function renderPane(
  el: PaneElements,
  sections: PaneSection[],
  cols: Columns,
  actions: PaneActions,
): RenderElement {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="column" rowGap={1}>
      {sections.length === 0 ? (
        <Text dimColor>No tracked items yet.</Text>
      ) : (
        sections.map(s => Section(el, s, cols, actions))
      )}
      <Box columnGap={1}>
        <Button key="refresh" hotkey="r" label="Refresh" onPress={actions.refresh} />
        <Text dimColor>Esc close</Text>
      </Box>
    </Box>
  )
}
