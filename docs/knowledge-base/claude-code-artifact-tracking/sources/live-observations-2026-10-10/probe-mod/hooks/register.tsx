import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Entry, Row } from '../types'
import { Availability, parseRemote } from './tools'

const log = atom({ plugin: 'probe', key: 'log' } as const, [] as Entry[])
const ticks = atom({ plugin: 'probe', key: 'ticks' } as const, 0)
const rowsAtom = atom({ plugin: 'probe', key: 'rows' } as const, [] as Row[])
const collapsed = atom({ plugin: 'probe', key: 'collapsed' } as const, [] as string[])
const PANE = 'probe-pane'
const loadId = Math.random().toString(36).slice(2, 8) // module variable: new value after each (re)load
const OUT = '<scratch>/out/'

const home = '~'
const redact = (s: string) => s.split(home).join('~')

async function attempt($: EngineInterface, label: string, fn: () => Promise<unknown>): Promise<Entry> {
  const t0 = await $.clock.now()
  try {
    const value = await fn()
    return { label, ok: true, ms: (await $.clock.now()) - t0, value }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    return { label, ok: false, ms: (await $.clock.now()) - t0, name: e?.name, message: redact(String(e?.message ?? err)) }
  }
}
const slim = (r: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }) => ({
  exitCode: r.exitCode, stdout: redact(r.stdout.slice(0, 300)), stderr: redact(r.stderr.slice(0, 300)), trunc: r.isStdoutTruncated,
})

async function push($: EngineInterface, e: Entry): Promise<void> {
  await update($, log, (l) => [...(l ?? []), e])
}

async function dump($: EngineInterface, name: string): Promise<void> {
  await $.fs.write(OUT + name, JSON.stringify(await read($, log), null, 1))
}

export const register: Register = (on) => {
  const rows: unknown[] = []
  let avail: Availability | undefined
  let starts = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe-run', description: 'process.run probes' })
    await $.command.register({ name: 'probe-timers', description: 'start timer probes' })
    await $.command.register({ name: 'probe-status', description: 'show/dump probe log', argumentHint: '[file]' })
    await $.command.register({ name: 'probe-avail', description: 'Availability cache probe' })
    await $.command.register({ name: 'probe-repo', description: 'session.repo probe' })
    await $.command.register({ name: 'probe-pane', description: 'open the probe pane' })
    await $.command.register({ name: 'probe-pane-later', description: 'open pane from a timer', argumentHint: '[tag]' })
    await $.command.register({ name: 'probe-timers2', description: 'long timer probes' })
    await $.command.register({ name: 'probe-globals', description: 'typeof globals' })
    await $.command.register({ name: 'probe-add', description: 'add a row from a command hook' })
    avail = new Availability((argv, init) => $.process.run(argv, init))
    let beat = 0
    const sid = await $.session.id()
    $.clock.every(2000, async () => {
      beat += 1
      await $.fs.write(OUT + 'heartbeat.json', JSON.stringify({ loadId, beat, sid, at: await $.clock.now() }))
    })
    starts += 1
    await $.fs.write(OUT + 'starts.json', JSON.stringify({ loadId, starts, sid, at: await $.clock.now() }))
    return next(e)
  })

  on('command.run', { command: 'probe-run' }, async ($) => {
    const R: Entry[] = []
    const run = async (label: string, argv: string[], init?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) =>
      R.push(await attempt($, label, async () => slim(await $.process.run(argv, init))))
    await run('A1 missing tool', ['definitely-not-a-tool-xyz', '--version'])
    await run('A2 gh --version', ['gh', '--version'])
    await run('A3 acli --version', ['acli', '--version'])
    await run('A4 which gh', ['which', 'gh'])
    await run('A4b which missing', ['which', 'definitely-not-a-tool-xyz'])
    await run('A6 sh -c command -v gh', ['sh', '-c', 'command -v gh; echo "rc=$?"'])
    await run('A6b sh -c command -v missing', ['sh', '-c', 'command -v definitely-not-a-tool-xyz; echo "rc=$?"'])
    await run('A7 timeout 1s on sleep 5', ['sleep', '5'], { timeoutMs: 1000 })
    await run('A8 pwd default cwd', ['pwd'])
    await run('A8b pwd cwd=/tmp', ['pwd'], { cwd: '/tmp' })
    await run('A8c pwd cwd relative "docs"', ['pwd'], { cwd: 'docs' })
    await run('A8d pwd cwd nonexistent', ['pwd'], { cwd: '/nonexistent-dir-xyz' })
    await run('A9 empty argv', [])
    await run('A10 relative ./gh', ['./gh', '--version'])
    await run('A10b absolute gh', ['/opt/homebrew/bin/gh', '--version'])
    await run('A11 gh with env PATH=/usr/bin', ['gh', '--version'], { env: { PATH: '/usr/bin' } })
    await run('A11b which gh with env PATH=/usr/bin', ['/usr/bin/env', 'sh', '-c', 'command -v gh; echo rc=$?'], { env: { PATH: '/usr/bin' } })
    await run('A14 non-executable file', ['/etc/hosts'])
    await run('A15 exit 3', ['sh', '-c', 'echo out; echo err 1>&2; exit 3'])
    await run('A15b killed by signal', ['sh', '-c', 'kill -9 $$'])
        await run('A5b env var names count', ['sh', '-c', 'env | wc -l'])
    await run('A5c env has CLAUDE vars (names only)', ['sh', '-c', 'env | cut -d= -f1 | grep -i "^CLAUDE\\|^ANTHROPIC" | sort | tr "\\n" " "'])
    R.push(await attempt($, 'A5d child PATH equals $.env.get(PATH)', async () => {
      const hostPath = await $.env.get('PATH')
      const child = (await $.process.run(['sh', '-c', 'printf %s "$PATH"'])).stdout
      return { equal: hostPath === child, entries: child.split(':').length }
    }))
    const t0 = await $.clock.now()
    const par = await attempt($, 'A16 3x sleep 1 in parallel', async () => {
      await Promise.all([1, 2, 3].map(() => $.process.run(['sleep', '1'])))
      return 'done'
    })
    R.push(par)
    R.push(await attempt($, 'A17 session.repo', async () => {
      const r = await $.session.repo()
      return r && { root: redact(r.root), remote: r.remote && r.remote.replace(/([:/])[^/:]+\/[^/]+$/, '$1<owner>/<repo>'), internal: r.internal, name: r.name, parsed: r.remote && (parseRemote(r.remote) ? { ...parseRemote(r.remote), owner: '<owner>', repo: '<repo>' } : null) }
    }))
    R.push(await attempt($, 'A18 session.root', async () => redact(await $.session.root())))
    await $.fs.write(OUT + 'probe-run.json', JSON.stringify(R, null, 1))
    return { text: `probe-run: ${R.length} entries written (${R.filter((x) => x.ok).length} ok)` }
  })

  on('command.run', { command: 'probe-avail' }, async ($) => {
    const R: Entry[] = []
    const t0 = await $.clock.now()
    const a = await avail!.has('gh'); const b = await avail!.has('gh'); const c = await avail!.has('definitely-not-a-tool-xyz')
    R.push({ label: 'avail', ok: true, value: { gh: a, gh2: b, missing: c } })
    return { text: JSON.stringify(R) }
  })

  on('command.run', { command: 'probe-timers' }, async ($) => {
    const start = await $.clock.now()
    // T1: after 300ms, process.run then state update
    $.clock.after(300, async () => {
      const t = await $.clock.now()
      const e = await attempt($, 'T1 after(300): process.run gh --version then update state', async () => slim(await $.process.run(['gh', '--version'])))
      await push($, { ...e, at: t - start })
    })
    // T2: every 1000 ms, 3 ticks then cancel
    let n = 0
    const timer = $.clock.every(1000, async () => {
      n += 1
      const t = await $.clock.now()
      await update($, ticks, (v) => (v ?? 0) + 1)
      await push($, { label: 'T2 every(1000) tick ' + n, ok: true, at: t - start })
      if (n >= 3) timer.cancel()
    })
    // T3: long callback: 12 s process.run inside the timer (hook budget is 10 s)
    $.clock.after(500, async () => {
      const e = await attempt($, 'T3 after(500): process.run sleep 12 (> 10 s hook budget)', async () => slim(await $.process.run(['sleep', '12'], { timeoutMs: 20000 })))
      await push($, { ...e, at: (await $.clock.now()) - start })
    })
    // T4: callback that sleeps with $.clock.sleep 11 s (sleep counts against a hook budget)
    $.clock.after(600, async () => {
      const e = await attempt($, 'T4 after(600): clock.sleep 11000', async () => { await $.clock.sleep(11000); return 'slept' })
      await push($, { ...e, at: (await $.clock.now()) - start })
    })
    // T5: callback that throws; later timers must still run
    $.clock.after(700, () => { throw new Error('T5 boom') })
    $.clock.after(1500, async () => push($, { label: 'T5b after throwing timer, still runs', ok: true, at: (await $.clock.now()) - start }))
    // T6: store.set from timer
    $.clock.after(800, async () => {
      const e = await attempt($, 'T6 store.set from timer', async () => { await $.store.set('probe-t6', { ok: 1 }); return await $.store.get('probe-t6') })
      await push($, { ...e, at: (await $.clock.now()) - start })
    })
    return { text: 'probe-timers: started' }
  })

  on('command.run', { command: 'probe-timers2' }, async ($) => {
    const start = await $.clock.now()
    // T7: a 45 s callback inside a timer
    $.clock.after(100, async () => {
      const e = await attempt($, 'T7 after(100): process.run sleep 45', async () => slim(await $.process.run(['sleep', '45'], { timeoutMs: 60000 })))
      await push($, { ...e, at: (await $.clock.now()) - start })
    })
    // T8: every(1000) whose callback takes 2500 ms: overlap or wait?
    let n = 0
    const t = $.clock.every(1000, async () => {
      n += 1
      const k = n
      await push($, { label: 'T8 every(1000) callback ' + k + ' start', ok: true, at: (await $.clock.now()) - start })
      await $.clock.sleep(2500)
      await push($, { label: 'T8 every(1000) callback ' + k + ' end', ok: true, at: (await $.clock.now()) - start })
      if (k >= 4) t.cancel()
    })
    return { text: 'probe-timers2: started' }
  })

  on('command.run', { command: 'probe-status' }, async ($, e) => {
    const l = await read($, log)
    const n = await read($, ticks)
    const file = e.args.trim() || 'status.json'
    await $.fs.write(OUT + file, JSON.stringify({ at: await $.clock.now(), ticks: n, log: l }, null, 1))
    return { text: `probe-status: ticks=${n} entries=${l.length} -> ${file}` }
  })

  on('command.run', { command: 'probe-repo' }, async ($) => {
    const r = await $.session.repo()
    return { text: JSON.stringify({ repo: r === null ? null : { remoteShape: r.remote && r.remote.replace(/([:/])[^/:]+\/[^/]+$/, '$1<owner>/<repo>'), internal: r.internal, name: r.name } }) }
  })

  on('command.run', { command: 'probe-pane' }, async ($) => {
    await update($, rowsAtom, () => [
      { id: 'J1', depth: 0, title: 'Parent story with a rather long title that must be truncated', type: 'story', status: 'in-progress', hasKids: true },
      { id: 'J2', depth: 1, title: 'Subtask', type: 'subtask', status: 'in-progress' },
      { id: 'J3', depth: 1, title: 'Bug', type: 'bug', status: 'todo' },
      { id: '#1', depth: 0, title: 'A pull request', type: 'PR', status: 'open', href: 'https://github.com/o/r/pull/1' },
      { id: 'W1', depth: 0, title: 'Example page', type: 'web', status: '', href: 'https://example.com/x' },
    ])
    const opened = await $.ui.open({ id: PANE, title: 'Tracking' })
    // timer writes state later: does the pane redraw by itself?
    $.clock.after(3000, async () => { await update($, rowsAtom, (l) => [...l, { id: 'T9', depth: 0, title: 'ADDED-BY-TIMER', type: 'x', status: 'new' }]) })
    return { text: 'probe-pane: ' + JSON.stringify(opened) }
  })

  on('command.run', { command: 'probe-pane-later' }, async ($, e) => {
    // an unrequested open: a timer, not the person
    $.clock.after(1000, async () => {
      const opened = await $.ui.open({ id: PANE, title: 'Tracking' })
      await $.fs.write(OUT + 'pane-open-' + (e.args.trim() || 'x') + '.json', JSON.stringify(opened))
    })
    return { text: 'probe-pane-later: scheduled' }
  })

  on('command.run', { command: 'probe-add' }, async ($) => {
    await update($, rowsAtom, (l) => [...l, { id: 'C' + (l.length + 1), depth: 0, title: 'ADDED-BY-COMMAND', type: 'x', status: 'new' }])
    return { text: 'probe-add: ok' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    void $.fs.write(OUT + 'render-props-' + (e.viewport?.columns ?? 'x') + '.json', JSON.stringify({ placement: e.props.placement, bodyColumns: e.props.bodyColumns, scroll: e.props.scroll, viewport: e.viewport, isFocused: e.props.isFocused, title: e.props.title }))
    const all = await read($, rowsAtom)
    const closed = await read($, collapsed)
    const shown: Row[] = []
    let skipDepth = -1
    for (const r of all) {
      if (skipDepth >= 0 && r.depth > skipDepth) continue
      skipDepth = closed.includes(r.id) ? r.depth : -1
      shown.push(r)
    }
    return (
      <Box flexDirection="column">
        <Box columnGap={1}>
          <Box width={14}><Text bold>Item</Text></Box>
          <Box flexGrow={1} flexShrink={1}><Text bold wrap="truncate-end">Title</Text></Box>
          <Box width={8}><Text bold>Type</Text></Box>
          <Box width={12}><Text bold>Status</Text></Box>
        </Box>
        {shown.map((r) => (
          <Box key={'row-' + r.id} columnGap={1}>
            <Box width={14} flexShrink={0} paddingLeft={r.depth * 2}>
              <Box width={2} flexShrink={0}>
                {r.hasKids ? (
                  <Button key={'t-' + r.id} plain label={closed.includes(r.id) ? '+' : '-'} onPress={() => update($, collapsed, (c) => (c.includes(r.id) ? c.filter((x) => x !== r.id) : [...c, r.id]))} />
                ) : (
                  <Text> </Text>
                )}
              </Box>
              <Text wrap="truncate-end">{r.id}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              {r.href ? <Text wrap="truncate-end"><Link href={r.href}>{r.title}</Link></Text> : <Text wrap="truncate-end">{r.title}</Text>}
            </Box>
            <Box width={8} flexShrink={0}><Text wrap="truncate-end">{r.type}</Text></Box>
            <Box width={12} flexShrink={0}><Text wrap="truncate-end" dimColor>{r.status}</Text></Box>
          </Box>
        ))}
      </Box>
    )
  })

  on('command.run', { command: 'probe-globals' }, async () => {
    const g = globalThis as Record<string, unknown>
    const names = ['Date', 'URL', 'URLSearchParams', 'Intl', 'TextEncoder', 'structuredClone', 'AbortController', 'setTimeout', 'setInterval', 'queueMicrotask', 'fetch', 'process', 'require', 'Buffer', 'crypto', 'console', 'RegExp', 'Map', 'Set', 'Promise', 'WeakRef', 'BigInt']
    const out: Record<string, string> = {}
    for (const n of names) out[n] = typeof g[n]
    let urlOk = ''
    try { const u = new URL('https://acme.atlassian.net/browse/ABC-12?x=1#y'); urlOk = u.host + '|' + u.pathname } catch (err) { urlOk = 'ERR ' + String(err) }
    let dateOk = ''
    try { dateOk = typeof Date.now() + '|' + new Date(0).toISOString() } catch (err) { dateOk = 'ERR ' + String(err) }
    let lookbehind = ''
    try { lookbehind = String(new RegExp('(?<![\\w/])#(\\d+)\\b').exec('see #12 and a#3')?.[1]) } catch (err) { lookbehind = 'ERR ' + String(err) }
    return { text: JSON.stringify({ out, urlOk, dateOk, lookbehind }) }
  })

  on('prompt.submit', async ($, e, next) => {
    await $.fs.write(OUT + 'events/prompt.submit-' + (await $.clock.now()) + '.json', JSON.stringify({ text: e.text, origin: e.origin, wait: e.wait, turnId: e.turnId }))
    return next(e)
  })
  on('command.run', async ($, e, next) => {
    await $.fs.write(OUT + 'events/command.run-' + (await $.clock.now()) + '.json', JSON.stringify({ command: e.command, args: e.args, origin: e.origin }))
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const text = e.door === 'attachment' ? '(omitted)' : redact(JSON.stringify(e.message.content).slice(0, 400))
    const row = { door: e.door, origin: e.origin, agentId: e.agentId, type: e.message.type, name: e.message.name, role: e.message.role, isMeta: e.message.isMeta, content: text }
    rows.push(row)
    await $.fs.write(OUT + 'rows/' + String(rows.length).padStart(3, '0') + '-' + e.door + '.json', JSON.stringify(row, null, 1))
    return stored
  })
}

// touched 1791630080.8973062
// touched for hot reload
// touched again
