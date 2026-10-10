// The /track pane: a tree table drawn from PaneSection[]. No `$` here: register.tsx passes the element table.
// Cells come from `cellsFor` in view.ts (spec 10.1): the only source of widths. Layout follows the live probe
// (KB mod-api-notes section 6): fixed-width cells, a growing title, columnGap 1.
import type { Color, Elements, RenderElement } from 'claude-code'
import type { Cell, PaneRow, PaneSection, Tone } from './view'
import { cellsFor, EMPTY_TEXT } from './view'

/** The four tags the pane uses. Every surface table holds them, so `$.ui.resolve(e)` fits. */
export type PaneElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

export type PaneActions = { fold(id: string): void; refresh(): void; dismiss(id: string): void }

const TONE_COLOR: Partial<Record<Tone, Color>> = { ok: 'green', warn: 'yellow', bad: 'red' }

/** Text props for a tone: a colour, dim, or nothing. */
function toneProps(tone: Tone | undefined): { color?: Color; dimColor?: boolean } {
  if (tone === 'dim') return { dimColor: true }
  const color = tone ? TONE_COLOR[tone] : undefined
  return color ? { color } : {}
}

function CellBox(el: PaneElements, row: PaneRow, cell: Cell, actions: PaneActions): RenderElement {
  const { Box, Text, Button, Link } = el
  const key = `cell-${cell.name}-${row.id}`
  const plain = row.dim ? 'dim' : undefined
  switch (cell.name) {
    case 'key':
      return (
        <Box key={key} width={cell.width} flexShrink={0} paddingLeft={row.depth * 2}>
          <Box width={2} flexShrink={0}>
            {row.foldable ? (
              <Button
                key={'fold-' + row.id}
                plain
                label={row.folded ? '+' : '-'}
                onPress={() => actions.fold(row.id)}
              />
            ) : (
              <Text> </Text>
            )}
          </Box>
          <Text wrap={cell.wrap} {...toneProps(plain)}>
            {row.href ? <Link href={row.href}>{row.key}</Link> : row.key}
          </Text>
        </Box>
      )
    case 'title':
      return (
        <Box key={key} flexGrow={1} flexShrink={1}>
          <Text wrap={cell.wrap} {...toneProps(plain)}>
            {row.title}
          </Text>
        </Box>
      )
    case 'type':
      return (
        <Box key={key} width={cell.width} flexShrink={0}>
          <Text wrap={row.typeWrap ?? cell.wrap} {...toneProps(plain)}>
            {row.type}
          </Text>
        </Box>
      )
    case 'status':
      return (
        <Box key={key} width={cell.width} flexShrink={0}>
          <Text wrap={cell.wrap} {...toneProps(plain ?? row.tone)}>
            {row.status}
          </Text>
        </Box>
      )
    case 'extra':
      return (
        <Box key={key} width={cell.width} flexShrink={0}>
          <Text wrap={cell.wrap} {...toneProps(plain ?? row.extraTone)}>
            {row.extra ?? ''}
          </Text>
        </Box>
      )
    case 'x': {
      const id = row.dismissId
      return (
        <Box key={key} width={cell.width} flexShrink={0}>
          {id !== undefined ? (
            <Button key={'dismiss-' + id} plain label="x" onPress={() => actions.dismiss(id)} />
          ) : (
            <Text> </Text>
          )}
        </Box>
      )
    }
  }
}

function Row(el: PaneElements, row: PaneRow, cells: readonly Cell[], actions: PaneActions): RenderElement {
  const { Box } = el
  return (
    <Box key={'row-' + row.id} columnGap={1}>
      {cells.map(cell => CellBox(el, row, cell, actions))}
    </Box>
  )
}

function Section(el: PaneElements, section: PaneSection, cells: readonly Cell[], actions: PaneActions): RenderElement {
  const { Box, Text } = el
  return (
    <Box key={'section-' + section.id} flexDirection="column">
      <Box columnGap={1}>
        <Text bold>{section.title}</Text>
        <Text dimColor>{section.note}</Text>
      </Box>
      {section.rows.map(row => Row(el, row, cells, actions))}
    </Box>
  )
}

function Body(
  el: PaneElements,
  sections: PaneSection[],
  cellsOf: (s: PaneSection) => readonly Cell[],
  actions: PaneActions,
): RenderElement {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="column" rowGap={1}>
      {sections.length === 0 ? (
        <Text dimColor>{EMPTY_TEXT}</Text>
      ) : (
        sections.map(s => Section(el, s, cellsOf(s), actions))
      )}
      <Box columnGap={1}>
        <Button key="refresh" hotkey="r" label="Refresh" onPress={actions.refresh} />
        <Text dimColor>Esc close</Text>
      </Box>
    </Box>
  )
}

/** Each section draws with `cellsFor(bodyColumns, layout, dismissable)`. */
export function renderSections(
  el: PaneElements,
  sections: PaneSection[],
  bodyColumns: number | undefined,
  actions: PaneActions,
): RenderElement {
  return Body(el, sections, s => cellsFor(bodyColumns, s.layout ?? 'items', s.dismissable === true), actions)
}
