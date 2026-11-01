import type { Register } from 'claude-code'

const OUT = '<SCRATCH>/out/ev.jsonl'
const body = (tag: string): string =>
  [
    '# Questions and answers ' + tag,
    '',
    '## Q1 · turn 1 · answered · 2026-10-27 10:00 UTC',
    '',
    '### Storage',
    '',
    'Where should the records live?',
    '',
    '- [x] **State only**: keep it in state',
    '- [ ] **Store**: persist it',
    '',
    '> Notes: SECRET246 typed note',
  ].join('\n')

const REPLY: Record<string, string> = {
  p246a: '\n' + body('A-LEADING-NL'),
  p246b: body('B-NO-LEADING-NL'),
  p246c: '\n## Q3 · turn 1 · answered · 2026-10-27 10:00 UTC\n\n### Storage\n\nWhere should the records live?\n\n- [x] **State only**: keep it',
  p246s: 'STUB246: Questions and answers Q1 are shown on the screen only.',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const name of Object.keys(REPLY)) await $.command.register({ name, description: 'probe 246 ' + name })
    let surfaces: unknown
    try {
      surfaces = await $.session.surfaces()
    } catch (err) {
      surfaces = 'err ' + String(err)
    }
    const prev = (await $.fs.exists(OUT)) ? await $.fs.read(OUT) : ''
    await $.fs.write(OUT, prev + JSON.stringify({ kind: 'session.start', surface: e.surface, isInteractive: e.isInteractive, surfaces }) + '\n')
    return next(e)
  })
  on('command.run', async ($, e, next) => {
    const text = REPLY[e.command]
    return text === undefined ? next(e) : { text }
  })
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'p246s') return next(e)
    return next({ ...e, props: { ...e.props, text: body('S-REWRITE') } })
  })
}
