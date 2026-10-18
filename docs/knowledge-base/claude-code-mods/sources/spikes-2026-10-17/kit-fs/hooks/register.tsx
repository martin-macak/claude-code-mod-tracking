// Spike G06. `/fsprobe <op> <path> [text]` calls $.fs.<op> and answers the result or the error message.
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('command.run', { command: 'fsprobe' }, async ($, e) => {
    const [op = '', path = '', ...rest] = e.args.split(' ')
    try {
      if (op === 'write') {
        await $.fs.write(path, rest.join(' '))
        return { text: 'OK write' }
      }
      if (op === 'exists') return { text: 'OK exists=' + String(await $.fs.exists(path)) }
      if (op === 'read') return { text: 'OK read=' + JSON.stringify(await $.fs.read(path)) }
      if (op === 'readroot') return { text: 'OK readroot=' + JSON.stringify(await $.fs.read(`${$.plugin.root}/data/shipped.txt`)) }
      return { text: 'unknown op ' + op }
    } catch (err) {
      return { text: 'ERR ' + op + ': ' + String((err as Error).message) }
    }
  }).catch((_$, e, next) => next(e))
}
