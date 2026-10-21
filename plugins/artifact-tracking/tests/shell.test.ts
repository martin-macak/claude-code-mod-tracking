import { expect, test } from 'claude-code/testing'
import { stripLead, stripReserved } from '../core/lib/shell'

test('stripReserved drops the reserved words in front of a command', () => {
  expect(stripReserved(['do', 'git', '-C', '/tmp/r', 'push'])).toEqual(['git', '-C', '/tmp/r', 'push'])
  expect(stripReserved(['then', 'else', 'sleep', '1'])).toEqual(['sleep', '1'])
  expect(stripReserved(['if', 'while', 'until', 'elif', 'do', 'then'])).toEqual([])
})

test('stripReserved drops !, which negates the pipeline that follows', () => {
  expect(stripReserved(['if', '!', 'git', 'diff'])).toEqual(['git', 'diff'])
  expect(stripReserved(['!', 'git', 'diff'])).toEqual(['git', 'diff'])
  expect(stripReserved(['git', 'diff', '!'])).toEqual(['git', 'diff', '!'])
})

test('stripReserved drops done, fi and esac, which end a compound', () => {
  expect(stripReserved(['done'])).toEqual([])
  expect(stripReserved(['fi'])).toEqual([])
  expect(stripReserved(['esac'])).toEqual([])
  expect(stripReserved(['fi', 'echo', 'x'])).toEqual(['echo', 'x'])
})

test('stripReserved keeps a reserved word that is not in front', () => {
  expect(stripReserved(['echo', 'if'])).toEqual(['echo', 'if'])
  expect(stripReserved(['git', 'push', 'then'])).toEqual(['git', 'push', 'then'])
})

test('stripReserved keeps for, case and select: their next word is a value, not a command', () => {
  expect(stripReserved(['for', 'd', 'in', 'a', 'b'])).toEqual(['for', 'd', 'in', 'a', 'b'])
  expect(stripReserved(['case', '$x', 'in'])).toEqual(['case', '$x', 'in'])
  expect(stripReserved(['select', 'opt', 'in', 'a'])).toEqual(['select', 'opt', 'in', 'a'])
})

test('stripReserved leaves a command without a reserved word as it is', () => {
  expect(stripReserved(['git', 'status'])).toEqual(['git', 'status'])
  expect(stripReserved([])).toEqual([])
})

// `time` is a reserved word that comes before `!`, and `!` comes before `time`: both orders are valid shell. A wrapper
// and a reserved word can follow each other, so one pass of each helper is not enough (Codex review of the PR).
test('stripLead drops reserved words and wrappers in any order', () => {
  const cmd = ['git', '-C', '/tmp/r', 'push']
  expect(stripLead(['time', '!', ...cmd]).words).toEqual(cmd)
  expect(stripLead(['!', 'time', ...cmd]).words).toEqual(cmd)
  expect(stripLead(['if', 'time', '!', 'sudo', ...cmd]).words).toEqual(cmd)
  expect(stripLead(['do', 'time', 'nohup', '!', ...cmd]).words).toEqual(cmd)
})

test('stripLead adds up the env and the nohup flag of every round', () => {
  const got = stripLead(['A=1', 'time', '!', 'B=2', 'A=3', 'nohup', 'sleep', '9'])
  expect(got).toEqual({ words: ['sleep', '9'], env: { A: '3', B: '2' }, nohup: true })
})

test('stripLead leaves a command with nothing in front as it is, and an assignment line empty', () => {
  expect(stripLead(['git', 'status'])).toEqual({ words: ['git', 'status'], env: {}, nohup: false })
  expect(stripLead(['L=/x'])).toEqual({ words: [], env: { L: '/x' }, nohup: false })
  expect(stripLead(['time', 'done'])).toEqual({ words: [], env: {}, nohup: false })
  expect(stripLead([])).toEqual({ words: [], env: {}, nohup: false })
})
