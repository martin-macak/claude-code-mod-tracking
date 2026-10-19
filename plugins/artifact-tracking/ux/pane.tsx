// The /track pane: a tree table drawn from PaneSection[]. No `$` here: register.tsx passes the element table.
// Cells come from `cellsFor` in view.ts (spec 10.1): the only source of widths. Layout follows the live probe
// (KB mod-api-notes section 6): fixed-width cells, a growing title, columnGap 1.
import type { Color, Elements, RenderElement } from 'claude-code'
import type { Priority } from '../hooks/contracts'
import { markerOf } from '../hooks/model/priority'
import type { Cell, PaneRow, PaneSection, Tone } from '../hooks/ui/view'
import { cellsFor, dismissKey, EMPTY_TEXT, foldKey, markKeys } from '../hooks/ui/view'

/** The four tags the pane uses. Every surface table holds them, so the engine's element resolver fits. */
export type PaneElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

/** `focus`: a press on a row's mark picks that row. `prioritize`: a priority key, on the picked row; undefined: `0`. */
export type PaneActions = {
  fold(id: string): void
  refresh(): void
  dismiss(id: string): void
  focus(id: string): void
  prioritize(level: Priority | undefined): void
}

/** The footer keys: one hotkey each, so no two Buttons claim the same key. `0` removes the person's mark. */
const PRIORITY_KEYS = [
  ['1', 'high', 'high'],
  ['2', 'normal', 'normal'],
  ['3', 'low', 'low'],
  ['0', 'auto', undefined],
] as const

const TONE_COLOR: Partial<Record<Tone, Color>> = { ok: 'green', warn: 'yellow', bad: 'red' }

/** Text props for a tone: a colour, dim, or nothing. */
function toneProps(tone: Tone | undefined): { color?: Color; dimColor?: boolean } {
  if (tone === 'dim') return { dimColor: true }
  const color = tone ? TONE_COLOR[tone] : undefined
  return color ? { color } : {}
}

function CellBox(
  el: PaneElements,
  row: PaneRow,
  cell: Cell,
  actions: PaneActions,
  marks: ReadonlyMap<string, string>,
): RenderElement {
  const { Box, Text, Button, Link } = el
  const key = `cell-${cell.name}-${row.id}`
  const plain = row.dim ? 'dim' : undefined
  switch (cell.name) {
    case 'prio': {
      // The first stop of the row for Tab. A blank label still takes the focus: the ring inverts it.
      const markKey = marks.get(row.id)
      const id = row.id
      return (
        <Box key={key} width={cell.width} flexShrink={0}>
          {markKey !== undefined ? (
            <Button
              key={markKey}
              plain
              label={markerOf(row.prio?.level) || ' '}
              {...(row.prio?.auto ? { dimColor: true } : {})}
              onPress={() => actions.focus(id)}
            />
          ) : (
            <Text> </Text>
          )}
        </Box>
      )
    }
    case 'key':
      return (
        <Box key={key} width={cell.width} flexShrink={0} paddingLeft={row.depth * 2}>
          <Box width={2} flexShrink={0}>
            {row.foldable ? (
              <Button key={foldKey(row.id)} plain label={row.folded ? '+' : '-'} onPress={() => actions.fold(row.id)} />
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
    case 'mark':
      return (
        <Box key={key} width={cell.width} flexShrink={0}>
          <Text wrap={cell.wrap} {...toneProps(plain ?? 'dim')}>
            {row.mark ?? ''}
          </Text>
        </Box>
      )
    case 'x': {
      const id = row.dismissId
      return (
        <Box key={key} width={cell.width} flexShrink={0}>
          {id !== undefined ? (
            <Button key={dismissKey(id)} plain label="x" onPress={() => actions.dismiss(id)} />
          ) : (
            <Text> </Text>
          )}
        </Box>
      )
    }
  }
}

function Row(
  el: PaneElements,
  row: PaneRow,
  cells: readonly Cell[],
  actions: PaneActions,
  marks: ReadonlyMap<string, string>,
): RenderElement {
  const { Box } = el
  return (
    <Box key={'row-' + row.id} columnGap={1}>
      {cells.map(cell => CellBox(el, row, cell, actions, marks))}
    </Box>
  )
}

function Section(
  el: PaneElements,
  section: PaneSection,
  cells: readonly Cell[],
  actions: PaneActions,
  marks: ReadonlyMap<string, string>,
): RenderElement {
  const { Box, Text } = el
  return (
    <Box key={'section-' + section.id} flexDirection="column">
      <Box columnGap={1}>
        <Text bold>{section.title}</Text>
        <Text dimColor>{section.note}</Text>
      </Box>
      {section.rows.map(row => Row(el, row, cells, actions, marks))}
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
  const marks = markKeys(sections)
  return (
    <Box flexDirection="column" rowGap={1}>
      {sections.length === 0 ? (
        <Text dimColor>{EMPTY_TEXT}</Text>
      ) : (
        sections.map(s => Section(el, s, cellsOf(s), actions, marks))
      )}
      <Box columnGap={1}>
        <Button key="refresh" hotkey="r" label="Refresh" onPress={actions.refresh} />
        {marks.size > 0
          ? PRIORITY_KEYS.map(([hotkey, label, level]) => (
              <Button
                key={'prio-' + hotkey}
                plain
                hotkey={hotkey}
                label={label}
                onPress={() => actions.prioritize(level)}
              />
            ))
          : null}
        <Text dimColor>Esc close</Text>
      </Box>
    </Box>
  )
}

/** Each section draws with `cellsFor(bodyColumns, layout, dismissable, prio)`. */
export function renderSections(
  el: PaneElements,
  sections: PaneSection[],
  bodyColumns: number | undefined,
  actions: PaneActions,
): RenderElement {
  return Body(
    el,
    sections,
    s => cellsFor(bodyColumns, s.layout ?? 'items', s.dismissable === true, s.prio === true),
    actions,
  )
}
