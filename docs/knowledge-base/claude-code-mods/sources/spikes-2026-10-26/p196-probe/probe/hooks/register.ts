// Scratch probe for issue 196: can a CommandOutput rewrite draw text that the model never reads?
// Commands: p196 (text rewrite), p196r (own tree), p196c (control, no rewrite), p196e (text ''), p196n (no text),
// p196s (stub only when a surface is attached, the whole text when none is).
import type { EngineInterface, Register } from 'claude-code'

const DIR = '<SCRATCH>/out/'
let seq = 0
let chain: Promise<void> = Promise.resolve()
function put($: EngineInterface, kind: string, data: unknown): Promise<void> {
  const n = ++seq
  chain = chain.then(
    () => put1($, n, kind, data),
    () => put1($, n, kind, data),
  )
  return chain
}
async function put1($: EngineInterface, n: number, kind: string, data: unknown): Promise<void> {
  try {
    const OUT = DIR + 'ev-' + (await $.session.id()).slice(0, 8) + '.jsonl'
    const prev = (await $.fs.exists(OUT)) ? await $.fs.read(OUT) : ''
    await $.fs.write(OUT, prev + JSON.stringify({ n, kind, at: Date.now(), data }) + '\n')
  } catch {
    // a log line must never fail a hook
  }
}

const cut = (s: unknown, max = 160): string => {
  const t = typeof s === 'string' ? s : JSON.stringify(s)
  return t === undefined ? String(t) : t.length > max ? `${t.slice(0, max)}…(${t.length})` : t
}

function mdOf(tag: string, args: string): string {
  const lines = [
    `# ${tag}-MARKER questions and answers (args="${args}")`,
    '',
    `## Q1 · turn 1 · answered`,
    '',
    '### Storage',
    '',
    'Where should the cache live?',
    '',
    '- [x] **State only**: keep it in $.state',
    '- [ ] **Store**: persist it with $.store',
    '',
    '> Notes: SECRET196 typed note',
    '',
  ]
  for (let i = 1; i <= 12; i++) lines.push(`- filler line ${i} of the long export`)
  lines.push('', '```text', 'fenced preview line', '```', '', `${tag}-END`)
  return lines.join('\n')
}

const STUB: Record<string, string | undefined> = {
  p196: 'STUB196T: the Q&A shows above, on screen only',
  p196r: 'STUB196R: the Q&A shows above, on screen only',
  p196c: '# CTRL196-MARKER control reply, no rewrite',
  p196e: '',
  p196n: undefined,
  p196d: 'STUB196D: the Q&A shows above, on screen only',
  p196l: 'STUB196L: the long Q&A shows above, on screen only',
}

// p196l: a long rewrite, about 150 KB (the questions slot caps at 256 KiB of JSON).
function longOf(args: string): string {
  const out = [`# QA196L-MARKER long export (args="${args}")`, '']
  for (let i = 1; i <= 2500; i++) out.push(`- line ${String(i).padStart(4, '0')} of the long export, padded with words to about sixty chars`)
  out.push('', 'QA196L-END')
  return out.join('\n')
}

// p196d: the data the render needs arrives 4 s after the start (like a stored copy that loads late), then a redraw is asked.
let loaded = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const name of ['p196', 'p196r', 'p196c', 'p196e', 'p196n', 'p196s', 'p196d', 'p196l']) {
      try {
        await $.command.register({ name, description: `probe 196 ${name}` })
      } catch (err) {
        await put($, 'register.err', { name, err: String(err) })
      }
    }
    let surfaces: unknown
    try {
      surfaces = await $.session.surfaces()
    } catch (err) {
      surfaces = `err ${String(err)}`
    }
    await put($, 'session.start', { surface: e.surface, isInteractive: e.isInteractive, surfaces })
    $.clock.after(4000, async () => {
      loaded = true
      await put($, 'loaded', {})
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (!e.command.startsWith('p196')) return next(e)
    let surfaces: readonly string[] = []
    try {
      surfaces = await $.session.surfaces()
    } catch {
      surfaces = []
    }
    await put($, 'command.run', { command: e.command, args: e.args, origin: e.origin, presentation: e.presentation, surfaces })
    if (e.command === 'p196s') {
      const out = surfaces.length === 0 ? { text: mdOf('QA196S-FULL', e.args) } : { text: 'STUB196S: the Q&A shows above, on screen only' }
      await put($, 'command.out', { command: e.command, text: cut(out.text) })
      return out
    }
    const stub = STUB[e.command]
    const out = stub === undefined ? {} : { text: stub }
    await put($, 'command.out', { command: e.command, text: cut(stub) })
    return out
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const p = e.props
    // no await: the log must not delay the answer (run F, fast hook)
    void put($, 'render.CommandOutput', {
      requestId: e.requestId,
      surface: e.surface,
      isFullscreen: e.viewport?.isFullscreen,
      command: p.command,
      args: p.args,
      text: cut(p.text),
      isErrored: p.isErrored,
      onScreen: p.onScreen,
    })
    if (!p.command.startsWith('p196') || p.command === 'p196c') return next(e)
    if (p.command === 'p196r') {
      const { Box, Text } = $.ui.resolve(e)
      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, { bold: true }, `QA196R-MARKER tree rewrite (args="${p.args}")`),
        h(Text, {}, '- [x] State only: keep it in $.state'),
        h(Text, { dimColor: true }, 'QA196R-END'),
      ) as never
    }
    if (p.command === 'p196s' && p.text.startsWith('QA196S-FULL')) return next(e)
    if (p.command === 'p196l') {
      const t0 = Date.now()
      const text = longOf(p.args)
      const drawn = await next({ ...e, props: { ...p, text } })
      void put($, 'render.p196l', { requestId: e.requestId, chars: text.length, ms: Date.now() - t0, onScreen: p.onScreen })
      return drawn
    }
    if (p.command === 'p196d' && !loaded) {
      void put($, 'render.p196d.notLoaded', { requestId: e.requestId })
      return next(e)
    }
    const tag = { p196: 'QA196T', p196e: 'QA196E', p196n: 'QA196N', p196s: 'QA196S', p196d: 'QA196D' }[p.command] ?? 'QA196X'
    const drawn = await next({ ...e, props: { ...p, text: mdOf(tag, p.args) } })
    void put($, 'render.CommandOutput.out', { requestId: e.requestId, type: cut((drawn as { type?: unknown })?.type, 40) })
    return drawn
  })

  on('session.append', async ($, e, next) => {
    const textOf = (): string => {
      if (e.door === 'attachment' || e.door === 'delivery' || e.door === 'hook-context') return '[omitted]'
      return cut(
        e.message.content.map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' | '),
        200,
      )
    }
    await put($, 'append', { door: e.door, origin: e.origin, name: e.message.name, type: e.message.type, role: e.message.role, uuid: e.uuid, text: textOf() })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await put($, 'turn.complete', { reason: e.reason, answer: cut(e.answer, 80) })
    return next(e)
  })
}
