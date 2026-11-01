import { expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
const writes: string[] = []
const beneath = (on: On, surfaces?: readonly string[]) => {
  writes.length = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => {
    writes.push(e.text)
    return { value: undefined }
  })
  if (surfaces) on('session.surfaces', () => ({ value: surfaces as never }))
}

test('K0 hook-side surfaces() when no hook answers session.surfaces (surface null)', async ($, on) => {
  beneath(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  console.log('K0 ' + writes.join('|'))
})

test('K0b hook-side surfaces() when no hook answers (surface terminal)', async ($, on) => {
  beneath(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  console.log('K0b ' + writes.join('|'))
})

test('K1 hook-side surfaces() answered []', async ($, on) => {
  beneath(on, [])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  console.log('K1 ' + writes.join('|'))
})

test('K3 CommandOutput rewrite through the kit: what next() received', async ($, on) => {
  beneath(on, ['terminal'])
  const seen: string[] = []
  on('ui.render', (_$, e) => {
    seen.push(JSON.stringify((e as { props: unknown }).props).slice(0, 200))
    return { type: 'Text', props: {}, children: ['engine row'] }
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const m = await $.ui.mount({
    plugin: 'p246-probe',
    component: 'CommandOutput',
    requestId: 'r1',
    surface: 'terminal',
    viewport: { columns: 100, rows: 30, isFullscreen: false },
    props: { command: 'p246s', args: '', text: 'p246-probe: STUB246', isErrored: false },
  } as never)
  console.log('K3 beneath saw ' + seen.join(' || '))
  await (m as { unmount(): Promise<void> }).unmount()
  expect(seen.length).toBeGreaterThan(0)
})
