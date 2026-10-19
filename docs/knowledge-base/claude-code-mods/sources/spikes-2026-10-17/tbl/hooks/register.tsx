// Throwaway spike "table" (issue 55): TreeDataTable prototype. Reference for the real component.
//
// /tbl [rows] [titleLen] [auto] [sticky] [long]
//   rows      total rows over 3 sections (default 300)
//   titleLen  0 = natural 40-80 chars; N = every title padded or cut to N chars (budget probes)
//   auto      autoFocus on the first row Button
//   sticky    the ui.focus hook writes `selected` only for row keys (r<idx>); default writes e.element ?? null
//   long      Box keys in the legacy long format (row-gh:github.com/acme/web#N, cell-<name>-...)
// /tbld       flush the event log to events.log
//
// Shape: header Text, then 3 x (section header row + rows), then a footer with hotkey Buttons x, y, d.
// A row is a Box of fixed-width cells: [Button r<idx>] [#idx] [title, truncate-end] [status] [age].
// Enter on a row Button toggles 2 detail rows. A ui.focus hook calls next(e) first, then writes `selected`.
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

declare const setTimeout: (fn: () => void, ms: number) => unknown
declare const clearTimeout: (t: unknown) => void

const PANE = 'tbl'
const DIR = '<SPIKES>/tbl'
// Outside the plugin folder: a --plugin-dir folder is watched, a write inside it would hot-reload the mod.
const LOG = `${DIR.replace(/\/tbl$/, '')}/live2-table/out/events.log`

type Cfg = { rows: number; titleLen: number; auto: boolean; sticky: boolean; long: boolean }
const DEFAULT: Cfg = { rows: 300, titleLen: 0, auto: false, sticky: false, long: false }

const cfgA = atom({ plugin: 'arch-spike-tbl', key: 'cfg' } as const, DEFAULT)
const selectedA = atom({ plugin: 'arch-spike-tbl', key: 'selected' } as const, null as string | null)
const expandedA = atom({ plugin: 'arch-spike-tbl', key: 'expanded' } as const, {} as Record<string, true>)
const lastActionA = atom({ plugin: 'arch-spike-tbl', key: 'lastAction' } as const, 'last action: -')

// ---- log: in memory, timestamped (epoch ms), flushed on demand or 700 ms after the last event ----
// `$` is never stored or assigned (the loader refuses it). note() gets it as a parameter, like the earlier spikes.
let lines: string[] = []
let timer: unknown = null

function note($: EngineInterface, msg: string): void {
  lines.push(`${Date.now()} ${msg}`)
  if (typeof setTimeout === 'function') {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      $.fs.write(LOG, lines.join('\n') + '\n').catch(() => {})
    }, 700)
  }
}

// ---- data ----
const WORDS = ['Fix', 'flaky', 'retry', 'logic', 'in', 'webhook', 'dispatcher', 'for', 'tenant', 'billing', 'export', 'when',
  'the', 'queue', 'stalls', 'after', 'a', 'schema', 'migration', 'rolls', 'back', 'Add', 'pagination', 'to', 'audit', 'log',
  'endpoint', 'and', 'cache', 'invalidation', 'on', 'permission', 'change']

function titleOf(i: number, titleLen: number): string {
  const want = titleLen > 0 ? titleLen : 40 + ((i * 7) % 41)
  let s = ''
  for (let k = i; s.length < want + 8; k++) s += `${WORDS[k % WORDS.length]} `
  s = `${s.trim()} ${i}`
  while (s.length < want) s += ' x'
  return s.slice(0, want)
}

const STATUS = ['open', 'merged', 'draft', 'closed']
const TONE = ['green', 'magenta', 'yellow', 'red']

function sectionsOf(rows: number): { name: string; from: number; count: number }[] {
  const out: { name: string; from: number; count: number }[] = []
  let from = 0
  for (let s = 0; s < 3; s++) {
    const count = Math.floor(rows / 3) + (s < rows % 3 ? 1 : 0)
    out.push({ name: 'ABC'[s] ?? '?', from, count })
    from += count
  }
  return out
}

// ---- tree stats: walk any drawn/returned tree, count nodes (typed objects), string children, characters ----
type Stats = { nodes: number; buttons: number; strings: number; chars: number }
function stats(tree: unknown): Stats {
  const s: Stats = { nodes: 0, buttons: 0, strings: 0, chars: 0 }
  const walk = (n: unknown) => {
    if (typeof n === 'string') {
      s.strings++
      s.chars += n.length
      return
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c)
      return
    }
    if (typeof n !== 'object' || n === null) return
    const node = n as { type?: unknown; props?: { children?: unknown; key?: unknown; label?: unknown }; children?: unknown }
    if (typeof node.type === 'string') {
      s.nodes++
      if (node.type === 'Button') s.buttons++
    }
    walk(node.children)
    if (node.props) walk(node.props.children)
  }
  walk(tree)
  return s
}

function parseArgs(args: string): Cfg {
  const cfg: Cfg = { ...DEFAULT }
  const nums: number[] = []
  for (const t of args.trim().split(/\s+/)) {
    if (t === '') continue
    if (/^\d+$/.test(t)) nums.push(Number(t))
    else if (t === 'auto') cfg.auto = true
    else if (t === 'sticky') cfg.sticky = true
    else if (t === 'long') cfg.long = true
  }
  if (nums[0] !== undefined) cfg.rows = nums[0]
  if (nums[1] !== undefined) cfg.titleLen = nums[1]
  return cfg
}

/** The kit mounts with requestId `tbl-r<rows>-t<titleLen>[-long][-auto]`; live uses the cfg atom. */
function cfgFromId(id: string, fallback: Cfg): Cfg {
  const m = /^tbl-r(\d+)-t(\d+)((?:-(?:long|auto|sticky))*)$/.exec(id)
  if (m === null) return fallback
  return {
    rows: Number(m[1]),
    titleLen: Number(m[2]),
    auto: (m[3] ?? '').includes('auto'),
    sticky: (m[3] ?? '').includes('sticky'),
    long: (m[3] ?? '').includes('long'),
  }
}

const isRowKey = (k: string | null | undefined): k is string => k !== null && k !== undefined && /^r\d+$/.test(k)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'tbl', description: 'Table spike: /tbl [rows] [titleLen] [auto] [sticky] [long]', argumentHint: '[rows] [titleLen] [auto] [sticky] [long]' })
      await $.command.register({ name: 'tbld', description: 'Table spike: flush the event log', argumentHint: '' })
    } catch {
      // ignore
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'tbl' }, async ($, e) => {
    const cfg = parseArgs(e.args)
    await update($, cfgA, () => cfg)
    await update($, selectedA, () => null)
    await update($, expandedA, () => ({}))
    await update($, lastActionA, () => 'last action: -')
    lines = []
    note($, `CMD ${JSON.stringify(cfg)}`)
    const opened = await $.ui.open({ id: PANE, title: 'Table spike', focus: true, closeOnEscape: true })
    return { text: `tbl opened rows=${cfg.rows} titleLen=${cfg.titleLen} auto=${cfg.auto} sticky=${cfg.sticky} long=${cfg.long} placed=${String(opened.isPlaced)}` }
  })

  on('command.run', { command: 'tbld' }, async $ => {
    await $.fs.write(LOG, lines.join('\n') + '\n')
    return { text: `tbld wrote ${lines.length} lines to ${LOG}` }
  })

  // The ring moves: call next(e) first, then write `selected` when the engine did not deny the move.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const t0 = Date.now()
    const r = await next(e)
    const t1 = Date.now()
    let wrote = '-'
    if (r.deny === undefined) {
      const cfg = await read($, cfgA)
      if (!cfg.sticky || isRowKey(e.element)) {
        const v = e.element ?? null
        await update($, selectedA, () => v)
        wrote = String(v)
      }
    }
    const t2 = Date.now()
    note($, `F el=${e.element ?? '-'} origin=${e.origin.kind} next=${t1 - t0}ms upd=${t2 - t1}ms deny=${r.deny ?? '-'} wrote=${wrote}`)
    return r
  }).catch((_$, e, next) => next(e))

  on('ui.press', { requestId: PANE }, ($, e, next) => {
    note($, `P el=${e.element}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    note($, `S by=${e.by} off=${e.offset} body=${e.bodyRows} of=${e.contentRows} origin=${e.origin.kind}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.close', { id: PANE }, ($, e, next) => {
    note($, `CLOSE origin=${e.origin.kind}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.fault', ($, e, next) => {
    note($, `FAULT ${e.phase} ${e.reason}`)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: /^tbl/ }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const t0 = Date.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const cfg = cfgFromId(e.requestId, await read($, cfgA))
    const sel = await read($, selectedA)
    const open = await read($, expandedA)
    const lastAction = await read($, lastActionA)
    const p = e.props

    const longKey = (name: string, i: number) => (cfg.long ? `cell-${name}-gh:github.com/acme/web#${i}` : undefined)
    const rowKey = (i: number) => (cfg.long ? `row-gh:github.com/acme/web#${i}` : undefined)

    const toggle = (key: string) => async () => {
      await update($, expandedA, m => {
        const copy: Record<string, true> = { ...m }
        if (copy[key]) delete copy[key]
        else copy[key] = true
        return copy
      })
      note($, `T toggle ${key}`)
    }
    const act = (which: 'x' | 'y') => async () => {
      const s = await read($, selectedA)
      const msg = isRowKey(s) ? `last action: ${which} on row ${s.slice(1)}` : `last action: ${which} on no row (selected=${String(s)})`
      await update($, lastActionA, () => msg)
      note($, `A ${msg}`)
    }

    const rowOf = (i: number, first: boolean) => {
      const key = `r${i}`
      const isOpen = open[key] === true
      const isSel = sel === key
      const status = STATUS[i % 4] ?? 'open'
      const row = (
        <Box key={rowKey(i)} flexDirection="row" columnGap={1} backgroundColor={isSel ? 'blue' : undefined}>
          <Box key={longKey('mark', i)} width={2} flexShrink={0}>
            <Button key={key} plain autoFocus={cfg.auto && first ? true : undefined} label={isOpen ? 'v' : '>'} onPress={toggle(key)} />
          </Box>
          <Box key={longKey('idx', i)} width={5} flexShrink={0} justifyContent="flex-end">
            <Text dimColor>{`#${i}`}</Text>
          </Box>
          <Box key={longKey('title', i)} width={48} flexShrink={0}>
            <Text wrap="truncate-end">{titleOf(i, cfg.titleLen)}</Text>
          </Box>
          <Box key={longKey('status', i)} width={8} flexShrink={0}>
            <Text color={TONE[i % 4]}>{status}</Text>
          </Box>
          <Box key={longKey('age', i)} width={5} flexShrink={0} justifyContent="flex-end">
            <Text dimColor>{`${(i % 59) + 1}m`}</Text>
          </Box>
        </Box>
      )
      if (!isOpen) return row
      return (
        <Box flexDirection="column">
          {row}
          <Box paddingLeft={8}>
            <Text dimColor wrap="truncate-end">{`detail 1 of row ${i}: opened by ${i % 7} people`}</Text>
          </Box>
          <Box paddingLeft={8}>
            <Text dimColor wrap="truncate-end">{`detail 2 of row ${i}: updated ${(i % 59) + 1}m ago`}</Text>
          </Box>
        </Box>
      )
    }

    const sections = sectionsOf(cfg.rows)
    const body = (
      <Box flexDirection="column">
        {sections.map(s => (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Box width={2} flexShrink={0} />
              <Text bold>{`Section ${s.name} (${s.count} rows)`}</Text>
            </Box>
            {Array.from({ length: s.count }, (_, k) => rowOf(s.from + k, s.from + k === 0))}
          </Box>
        ))}
      </Box>
    )
    const st = stats(body)
    const header = (
      <Box flexDirection="column">
        <Text bold>{`rows=${cfg.rows} tl=${cfg.titleLen} nodes=${st.nodes} str=${st.strings} chars=${st.chars} btn=${st.buttons} sel=${String(sel)} foc=${p.isFocused ? 1 : 0} off=${p.scroll.offset}`}</Text>
        <Text color="cyan">{lastAction}</Text>
      </Box>
    )
    const footer = (
      <Box flexDirection="column">
        <Text color="cyan">{lastAction}</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="fx" plain hotkey="x" label="act-x" onPress={act('x')} />
          <Button key="fy" plain hotkey="y" label="act-y" onPress={act('y')} />
          <Button
            key="fd"
            plain
            hotkey="d"
            label="dump"
            onPress={() => {
              $.fs.write(LOG, lines.join('\n') + '\n').catch(() => {})
            }}
          />
        </Box>
      </Box>
    )
    const tree = (
      <Box flexDirection="column">
        {header}
        {body}
        {footer}
      </Box>
    )
    note($, `R rows=${cfg.rows} nodes=${st.nodes} str=${st.strings} chars=${st.chars} btn=${st.buttons} sel=${String(sel)} foc=${p.isFocused ? 1 : 0} off=${p.scroll.offset} ${p.placement} cols=${p.bodyColumns} build=${Date.now() - t0}ms`)
    return tree
  }).catch((_$, e, next) => next(e))
}
