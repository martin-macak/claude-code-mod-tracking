// Throwaway spike (issue 55 gaps G03 G08 G09 G10 G14 G16). One pane, several modes picked by `/spike <mode>`.
//   grid           40 rows of fixed-width cells, one focusable Button per row, hotkeys h (header), w (row 3),
//                  q (row 35), f (footer), z (inside a display:none Box). G03 G09 G14 G16.
//   keys           36 plain Buttons, hotkeys a-z and 0-9. G10.
//   colors         Text and Box colors in many raw formats. G16.
//   color <raw>    one raw color string on a Text, a Text background and a fixed-width Box. G16 (bad values).
//   client         a Client region between two Buttons. G08.
// Evidence: the status line under the prompt (last events) and a file log, both written by the hooks.
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

const PANE = 'spike'
const LOG = '<SPIKES>/live-ui/events.log'

const mode = atom({ plugin: 'arch-spike-ui', key: 'mode' } as const, 'grid')
const count = atom({ plugin: 'arch-spike-ui', key: 'count' } as const, 0)
const last = atom({ plugin: 'arch-spike-ui', key: 'last' } as const, '-')

let lines: string[] = []

/** Appends to the file log and mirrors the last events on the status line under the prompt. */
function note($: EngineInterface, msg: string): void {
  lines.push(`${Date.now() % 100000} ${msg}`)
  if (lines.length > 300) lines = lines.slice(-300)
  $.fs.write(LOG, lines.join('\n') + '\n').catch(() => {})
  $.ui.status('spike: ' + lines.slice(-4).map(l => l.slice(l.indexOf(' ') + 1)).join(' | '))
}

const pad = (n: number) => String(n).padStart(2, '0')

const COLORS = ['#ff0000', '#f00', 'rgb(0,128,0)', 'rgb(0, 128, 0)', 'red', 'ansi:red', 'ansi256(208)', 'orange', 'redBright',
  'success', 'error', 'warning', 'claude', 'permission', 'suggestion', 'subtle', 'inactive', 'diffAdded']

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'spike', description: 'Spike pane: grid|keys|colors|color <raw>|client', argumentHint: '[grid|keys|colors|color <raw>|client]' })
    } catch {
      // ignore
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'spike' }, async ($, e) => {
    const arg = e.args.trim()
    await update($, mode, () => (arg === '' ? 'grid' : arg))
    note($, `cmd ${arg === '' ? 'grid' : arg}`)
    const opened = await $.ui.open({ id: PANE, title: 'Spike', focus: true, closeOnEscape: true })
    return { text: `spike opened placed=${String(opened.isPlaced)}` }
  })

  on('ui.focus', { requestId: PANE }, ($, e, next) => {
    note($, `F:${e.element ?? '-'}/${e.origin.kind}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    note($, `S:by${e.by} off${e.offset} body${e.bodyRows} of${e.contentRows}/${e.origin.kind}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.press', { requestId: PANE }, ($, e, next) => {
    note($, `P:${e.element}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.message', { requestId: PANE }, ($, e, next) => {
    note($, `M:${JSON.stringify(e)}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.fault', ($, e, next) => {
    note($, `FAULT ${e.phase} ${e.reason}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.close', { id: PANE }, ($, e, next) => {
    note($, `CLOSE ${e.origin.kind}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Client } = $.ui.resolve(e)
    const m = await read($, mode)
    const n = await read($, count)
    const lastKey = await read($, last)
    const p = e.props
    note($, `R:${m} foc${p.isFocused ? 1 : 0} off${p.scroll.offset} body${p.scroll.bodyRows} ${p.placement} cols${p.bodyColumns} vp${e.viewport?.columns ?? '?'}x${e.viewport?.rows ?? '?'}`)
    const hit = (key: string) => () => {
      void update($, count, v => v + 1)
      void update($, last, () => key)
    }

    const header = (
      <Box key="hdr" flexDirection="row" columnGap={1}>
        <Text bold>{`[${m}] n=${n} last=${lastKey} foc=${p.isFocused ? 1 : 0} off=${p.scroll.offset} body=${p.scroll.bodyRows} ${p.placement} cols=${p.bodyColumns}`}</Text>
      </Box>
    )

    if (m === 'keys') {
      const rows: string[][] = []
      for (let i = 0; i < LETTERS.length; i += 12) rows.push(LETTERS.slice(i, i + 12))
      return (
        <Box flexDirection="column">
          {header}
          {rows.map((row, i) => (
            <Box key={'kr' + i} flexDirection="row" columnGap={1}>
              {row.map(c => (
                <Button key={'k-' + c} plain hotkey={c} label={c} onPress={hit('k-' + c)} />
              ))}
            </Box>
          ))}
          <Box key="dups" flexDirection="row" columnGap={1}>
            <Button key="dup-a-late" plain hotkey="a" label="dup a (later)" onPress={hit('dup-a-late')} />
          </Box>
        </Box>
      )
    }

    if (m === 'colors') {
      return (
        <Box flexDirection="column">
          {header}
          {COLORS.map(c => (
            <Box key={'c-' + c} flexDirection="row" columnGap={1}>
              <Box width={16}>
                <Text>{c}</Text>
              </Box>
              <Text color={c}>{`TEXT-${c}`}</Text>
              <Text backgroundColor={c}>{`BG-${c}`}</Text>
              <Box width={10} backgroundColor={c}>
                <Text>box10</Text>
              </Box>
              <Text>|</Text>
            </Box>
          ))}
        </Box>
      )
    }

    if (m.startsWith('color ')) {
      const raw = m.slice('color '.length)
      return (
        <Box flexDirection="column">
          {header}
          <Text color={raw}>{`TEXT[${raw}]`}</Text>
          <Text backgroundColor={raw}>{`BG[${raw}]`}</Text>
          <Box width={12} backgroundColor={raw}>
            <Text>box12</Text>
          </Box>
          <Text>after</Text>
        </Box>
      )
    }

    if (m === 'client') {
      return (
        <Box flexDirection="column">
          {header}
          <Button key="before" label="Before" onPress={hit('before')} />
          <Client key="kc" module="./client/keys.tsx" width={44} height={5} props={{ title: 'client region' }} />
          <Button key="after" label="After" onPress={hit('after')} />
          <Button
            key="ffk"
            hotkey="g"
            label="Focus kc (g)"
            onPress={() => {
              $.ui.focus({ requestId: PANE, key: 'kc' }).then(
                r => note($, 'UIFOCUS ' + JSON.stringify(r)),
                (err: unknown) => note($, 'UIFOCUS-ERR ' + String(err)),
              )
            }}
          />
        </Box>
      )
    }

    // grid
    const rows: number[] = []
    for (let i = 1; i <= 40; i++) rows.push(i)
    const TINT = ['success', '#ff8800', 'rgb(0,128,255)', 'red']
    return (
      <Box flexDirection="column">
        {header}
        <Box key="g14" flexDirection="row" columnGap={1}>
          <Box width={12} backgroundColor="blue" justifyContent="flex-start">
            <Text>ab</Text>
          </Box>
          <Box width={12} backgroundColor="blue" justifyContent="center">
            <Text>ab</Text>
          </Box>
          <Box width={12} backgroundColor="blue" justifyContent="flex-end">
            <Text>ab</Text>
          </Box>
          <Box width={8} backgroundColor="magenta">
            <Text wrap="truncate-end">ABCDEFGHIJKLMNOPQRSTUVWXYZ0123</Text>
          </Box>
          <Box width={8} backgroundColor="magenta">
            <Text>ABCDEFGHIJKLMNOPQRSTUVWXYZ0123</Text>
          </Box>
        </Box>
        <Box key="g16" flexDirection="row" columnGap={1}>
          <Text color="#ff0000">hex</Text>
          <Text color="rgb(0,128,0)">rgb</Text>
          <Text color="red">name</Text>
          <Text color="ansi256(208)">a256</Text>
          <Text color="success">theme</Text>
          <Text backgroundColor="#0000ff">bghex</Text>
          <Box width={10} backgroundColor="#0000ff">
            <Text>box10</Text>
          </Box>
          <Text>|</Text>
        </Box>
        <Box key="hid" display="none">
          <Button key="hidden-z" hotkey="z" label="hidden z" onPress={hit('hidden-z')} />
        </Box>
        <Box key="hdrbtn" flexDirection="row" columnGap={1}>
          <Button key="hot-h" hotkey="h" label="Hot h (header)" onPress={hit('hot-h')} />
        </Box>
        {rows.map(i => (
          <Box key={'row' + pad(i)} flexDirection="row" columnGap={1}>
            <Box width={4} justifyContent="flex-end">
              <Text dimColor>{pad(i)}</Text>
            </Box>
            <Box width={12} backgroundColor={i % 2 === 0 ? 'blue' : 'green'}>
              <Text>{`name-${pad(i)}`}</Text>
            </Box>
            <Box width={8} justifyContent="flex-end">
              <Text color={TINT[i % 4]}>{String(i * 37)}</Text>
            </Box>
            <Box width={10} justifyContent="center">
              <Text color={TINT[(i + 1) % 4]} backgroundColor={i % 3 === 0 ? 'yellow' : undefined}>{i % 5 === 0 ? 'warn' : 'ok'}</Text>
            </Box>
            {i === 35 ? (
              <Button key="row-35" hotkey="q" autoFocus label={`Go ${pad(i)} (q)`} onPress={hit('row-35')} />
            ) : i === 3 ? (
              <Button key="row-03" hotkey="w" label={`Go ${pad(i)} (w)`} onPress={hit('row-03')} />
            ) : (
              <Button key={'row-' + pad(i)} label={`Go ${pad(i)}`} onPress={hit('row-' + pad(i))} />
            )}
          </Box>
        ))}
        <Box key="foot" flexDirection="row" columnGap={1}>
          <Button key="hot-f" hotkey="f" label="Hot f (footer)" onPress={hit('hot-f')} />
          <Text dimColor>{`END n=${n} last=${lastKey}`}</Text>
        </Box>
      </Box>
    )
  }).catch((_$, e, next) => next(e))
}
