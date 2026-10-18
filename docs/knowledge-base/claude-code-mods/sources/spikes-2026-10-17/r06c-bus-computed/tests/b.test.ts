import { mock, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

test('bus: Map dispatch on tool.call and a const-array door matcher', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('tool.call', () => ({ ref: 'r', result: 'engine' }) as never)
  mock.session(on)
  for (const tool of ['Read', 'Bash', 'Grep', 'Edit', 'Glob']) {
    await $.tool.call({ tool, file_path: '/x', command: 'ls', pattern: 'p', old_string: 'a', new_string: 'b' } as never)
  }
  for (const door of ['tool-result', 'tool-message', 'response', 'prompt', 'note'] as const) {
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'row ' + door }] },
      door,
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'u-' + door,
    } as never)
  }
  for (const [k, v] of [...store.entries()].sort()) console.log(`   ${k} = ${String(v)}`)
})
