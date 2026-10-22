// fakePorts is the base of the Node unit tests of Persistence, SessionWatch, Scheduler and the rest.
// These cases pin its clock and its stores, so a test that fails later points at the code and not at the fake.
import { expect, test } from 'claude-code/testing'
import { fakePorts } from './fixtures/ports'

test('advance fires due timers in time order and moves the clock to the target', async () => {
  const w = fakePorts()
  const seen: string[] = []
  w.ports.clock.after(50, () => void seen.push('b'))
  w.ports.clock.after(20, () => void seen.push('a'))
  w.ports.clock.after(100, () => void seen.push('c'))
  await w.clock.advance(60)
  expect(seen).toEqual(['a', 'b'])
  expect(w.clock.now).toBe(60)
  expect(await w.ports.clock.now()).toBe(60)
  await w.clock.advance(40)
  expect(seen).toEqual(['a', 'b', 'c'])
})

test('advance awaits an async callback before it fires the next timer', async () => {
  const w = fakePorts()
  const seen: string[] = []
  w.ports.clock.after(10, (async () => {
    seen.push('first start')
    await Promise.resolve()
    await Promise.resolve()
    seen.push('first end')
  }) as () => void)
  w.ports.clock.after(20, () => void seen.push('second'))
  await w.clock.advance(30)
  expect(seen).toEqual(['first start', 'first end', 'second'])
})

test('a timer armed inside a callback fires in the same advance when it falls due', async () => {
  const w = fakePorts()
  const seen: number[] = []
  w.ports.clock.after(10, () => {
    seen.push(w.clock.now)
    w.ports.clock.after(5, () => void seen.push(w.clock.now))
    w.ports.clock.after(50, () => void seen.push(w.clock.now))
  })
  await w.clock.advance(20)
  expect(seen).toEqual([10, 15])
})

test('an every fires each period, and cancel stops it', async () => {
  const w = fakePorts()
  let beats = 0
  const timer = w.ports.clock.every(100, () => void beats++)
  await w.clock.advance(350)
  expect(beats).toBe(3)
  timer.cancel()
  await w.clock.advance(500)
  expect(beats).toBe(3)
})

test('a cancelled after never fires', async () => {
  const w = fakePorts()
  let fired = 0
  w.ports.clock.after(10, () => void fired++).cancel()
  await w.clock.advance(100)
  expect(fired).toBe(0)
})

test('refuse: the next after of that delay never fires; a later one does', async () => {
  const w = fakePorts()
  const seen: string[] = []
  w.clock.refuse('after', 1500)
  w.ports.clock.after(1500, () => void seen.push('refused'))
  await w.clock.advance(3000)
  w.ports.clock.after(1500, () => void seen.push('second'))
  await w.clock.advance(1500)
  expect(seen).toEqual(['second'])
})

test('refuse: a refused every period ends the interval', async () => {
  const w = fakePorts()
  let beats = 0
  w.ports.clock.every(100, () => void beats++)
  await w.clock.advance(250)
  expect(beats).toBe(2)
  w.clock.refuse('every', 100)
  await w.clock.advance(1000)
  expect(beats).toBe(2)
})

test('the store clones what it keeps and what it gives, counts sets and lists keys', async () => {
  const w = fakePorts({ store: { seeded: { a: 1 } } })
  const value = { list: [1] }
  await w.ports.store.set('k', value)
  value.list.push(2)
  expect(await w.ports.store.get('k')).toEqual({ list: [1] })
  expect(w.storeSets).toBe(1)
  expect((await w.ports.store.keys()).sort()).toEqual(['k', 'seeded'])
  await w.ports.store.delete('k')
  expect(await w.ports.store.get('k')).toBeUndefined()
})

test('state atoms and slots read their empty value, update, and count writes by member', async () => {
  const w = fakePorts()
  expect(await w.ports.state.items.get()).toEqual([])
  expect(await w.ports.state.tools.get()).toEqual({})
  expect(await w.ports.state.expanded.get()).toEqual([])
  expect(await w.ports.state.slot.get('repos')).toBeUndefined()
  await w.ports.state.expanded.update(cur => [...cur, 'github'])
  await w.ports.state.slot.update('repos', cur => [...((cur as string[] | undefined) ?? []), 'r1'])
  expect(await w.ports.state.expanded.get()).toEqual(['github'])
  expect(await w.ports.state.slot.get('repos')).toEqual(['r1'])
  expect(w.stateSets).toEqual({ expanded: 1, repos: 1 })
})

test('run records the argv, asks the hook, and otherwise exits 1', async () => {
  const w = fakePorts()
  w.run = argv => (argv[0] === 'gh' ? { exitCode: 0, stdout: 'ok', stderr: '' } : undefined)
  expect((await w.ports.run(['gh', '--version'], {})).stdout).toBe('ok')
  const other = await w.ports.run(['git', 'status'], {})
  expect(other.exitCode).toBe(1)
  expect(other.stderr).toContain('unexpected call: git status')
  expect(w.calls).toEqual([
    ['gh', '--version'],
    ['git', 'status'],
  ])
})

test('fs writes, reads, stats and refuses a missing path', async () => {
  const w = fakePorts({ files: { '/a': 'one' } })
  await w.clock.advance(5)
  await w.ports.fs.write('/b', 'two')
  expect(await w.ports.fs.read('/b')).toBe('two')
  expect(await w.ports.fs.exists('/a')).toBe(true)
  expect(await w.ports.fs.exists('/c')).toBe(false)
  expect(await w.ports.fs.stat('/c')).toBeNull()
  expect(await w.ports.fs.stat('/b')).toEqual({ kind: 'file', size: 3, mtimeMs: 5, isLink: false })
  expect((await w.ports.fs.stat('/b', { resolve: true }))?.realPath).toBe('/b')
  await expect(w.ports.fs.read('/c')).rejects.toThrow('ENOENT')
})

test('session, env, settings, agents and ui answer what the test set', async () => {
  const w = fakePorts({
    session: { id: 's9', cwd: '/x', repo: { host: 'github.com', owner: 'o', repo: 'r' } },
    env: { HOME: '/home/me' },
    settings: { theme: 'dark' },
    agents: [{ id: 'a1', status: 'running' }],
  })
  expect(await w.ports.session.id()).toBe('s9')
  expect(await w.ports.session.cwd()).toBe('/x')
  expect((await w.ports.session.repo())?.owner).toBe('o')
  expect(await w.ports.session.messages()).toEqual([])
  expect(await w.ports.env.get('HOME')).toBe('/home/me')
  expect(await w.ports.env.get('XDG_CONFIG_HOME')).toBeUndefined()
  expect(await w.ports.settings.read()).toEqual({ theme: 'dark' })
  expect((await w.ports.agents.list()).map(a => a.id)).toEqual(['a1'])
  expect(await w.ports.ui.open()).toBe(true)
  await w.ports.ui.focus('k')
  w.ports.ui.invalidate()
  w.ports.ui.toast('hi')
  expect(await w.ports.ui.copy('text')).toEqual({ isCopied: true })
  w.ports.log('line')
  expect(w.ui).toEqual({
    opened: 1,
    openedWith: [null], // nothing was selected at the open
    placed: true,
    focused: ['k'],
    invalidated: 1,
    toasts: ['hi'],
    copied: ['text'],
    copyResult: { isCopied: true },
    panes: [],
  })
  w.ui.placed = false // a terminal too narrow for the pane
  w.state.set('selected', 'row-1')
  expect(await w.ports.ui.open()).toBe(false)
  expect(w.ui.openedWith).toEqual([null, 'row-1']) // the row that is selected when the pane opens
  expect(await w.ports.ui.panes()).toEqual([])
  expect(w.logs).toEqual(['line'])
})
