// Spike G17. The Pane size comes from the requestId: `r<rows>-d<0|1>-n<depth>-t<textChars>`.
//   rows   item rows, each a Box with 6 fixed-width cells (Box > Text; the first cell holds a Button)
//   d1     one extra detail row under each item row
//   depth  extra nesting of plain Boxes around the whole table
//   textChars  one Text with this many characters at the end
import type { Register } from 'claude-code'

export const register: Register = on => {
  // Calibration: `c-<kind>` draws one Text of 98,000 characters, then 3,000 copies of one element kind.
  on('ui.render', { component: 'Pane', requestId: /^c-/ }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const kind = e.requestId.slice(2)
    const pad = Number(/^(\d+)-/.exec(kind)?.[1] ?? 98000)
    const k = kind.replace(/^\d+-/, '')
    const one = (i: number) => {
      const id = String(i).padStart(4, '0')
      if (k === 'btn-key5') return <Button key={`k${id}`} label="a" onPress={() => {}} />
      if (k === 'btn-key50') return <Button key={`k${id}-${'y'.repeat(45)}`} label="a" onPress={() => {}} />
      if (k === 'btn-label10') return <Button key={`k${id}`} label={'abcdefghi' + 'j'} onPress={() => {}} />
      if (k === 'text1') return <Text key={`t${id}`}>a</Text>
      if (k === 'text1-nokey') return <Text>a</Text>
      if (k === 'box-key20') return <Box key={`b${id}-${'z'.repeat(15)}`}><Text>a</Text></Box>
      if (k === 'box-nokey') return <Box><Text>a</Text></Box>
      if (k === 'link40') return <Text><Link href={`https://example.com/${'q'.repeat(20)}/${id}`}>a</Link></Text>
      return <Text>?</Text>
    }
    return (
      <Box flexDirection="column">
        <Text>{'x'.repeat(pad)}</Text>
        {Array.from({ length: 3000 }, (_, i) => one(i))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const m = /^r(\d+)-d(\d)-n(\d+)-t(\d+)(?:-(real|realkeys))?$/.exec(e.requestId)
    const real = m?.[5] === 'real' || m?.[5] === 'realkeys'
    const realKeys = m?.[5] === 'realkeys'
    const rows = Number(m?.[1] ?? 3)
    const detail = m?.[2] === '1'
    const depth = Number(m?.[3] ?? 0)
    const textChars = Number(m?.[4] ?? 0)
    const WIDTHS = [4, 10, 28, 12, 8, 6]

    const cells = (i: number, header: boolean) =>
      WIDTHS.map((w, c) => (
        <Box key={`c${header ? 'h' : i}-${c}`} width={w} flexShrink={0}>
          {c === 0 && !header ? (
            <Button key={`mark-${i}`} plain label=">" onPress={() => {}} />
          ) : (
            <Text wrap="truncate-end" bold={header}>
              {header ? `H${c}` : `r${i}c${c} value`}
            </Text>
          )}
        </Box>
      ))

    // The shape of one /track row today (hooks/ui/pane.tsx CellBox): 8 cells, the first and last hold a Button,
    // the key cell holds a fold Button, a Text and a Link.
    // realkeys: the Box keys have the real format, `row-<id>` and `cell-<name>-<id>`, id = `gh:github.com/acme/web#<n>`.
    const realRow = (i: number) => {
      const id = `gh:github.com/acme/web#${i}`
      const kRow = realKeys ? `row-${id}` : `row-${i}`
      const kc = (name: string) => (realKeys ? `cell-${name}-${id}` : `c${name[0]}-${i}`)
      return (
      <Box key={kRow} columnGap={1}>
        <Box key={kc('prio')} width={2} flexShrink={0}>
          <Button key={`mark-${i}`} plain label=" " onPress={() => {}} />
        </Box>
        <Box key={kc('key')} width={14} flexShrink={0} paddingLeft={2}>
          <Box width={2} flexShrink={0}>
            <Button key={`fold-${i}`} plain label="-" onPress={() => {}} />
          </Box>
          <Text wrap="truncate-end">
            <Link href={`https://github.com/acme/web/issues/${i}`}>{`acme/web#${i}`}</Link>
          </Text>
        </Box>
        <Box key={kc('title')} flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{`Title of item ${i}`}</Text>
        </Box>
        <Box key={kc('type')} width={6} flexShrink={0}>
          <Text wrap="truncate-end">PR</Text>
        </Box>
        <Box key={kc('status')} width={8} flexShrink={0}>
          <Text wrap="truncate-end" color="green">OPEN</Text>
        </Box>
        <Box key={kc('extra')} width={8} flexShrink={0}>
          <Text wrap="truncate-end">extra</Text>
        </Box>
        <Box key={kc('mark')} width={4} flexShrink={0}>
          <Text wrap="truncate-end" dimColor>mark</Text>
        </Box>
        <Box key={kc('x')} width={2} flexShrink={0}>
          <Button key={`x-${i}`} plain label="x" onPress={() => {}} />
        </Box>
      </Box>
      )
    }

    const body = (
      <Box flexDirection="column">
        <Box key="header" columnGap={1}>
          {cells(0, true)}
        </Box>
        {Array.from({ length: rows }, (_, i) => (
          <Box key={`item-${i}`} flexDirection="column">
            {real ? realRow(i) : (
              <Box key={`row-${i}`} columnGap={1}>
                {cells(i, false)}
              </Box>
            )}
            {detail && (
              <Box key={`detail-${i}`} paddingLeft={4}>
                <Text dimColor wrap="truncate-end">{`detail of ${i}: opened by x, updated y`}</Text>
              </Box>
            )}
          </Box>
        ))}
        {textChars > 0 && <Text>{'x'.repeat(textChars)}</Text>}
      </Box>
    )
    let tree = body
    for (let d = 0; d < depth; d++) tree = <Box key={`wrap-${d}`}>{tree}</Box>
    return tree
  })
}
