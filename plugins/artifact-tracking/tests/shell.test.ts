import { expect, test } from 'claude-code/testing'
import { splitShell, stripLead, stripReserved } from '../core/lib/shell'

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

// The scope of a segment is the subshell it runs in. Segments with the same scope run in the same shell.
// A segment is named by its words: `at('a | b').a` is the scope of `a`.
const at = (cmd: string): Record<string, string> =>
  Object.fromEntries(splitShell(cmd).map(s => [s.words.join(' '), s.scope]))

test('splitShell gives each part of a pipeline a scope of its own, the last part too', () => {
  const p = at('a | b |& c; d')
  expect(p.d).toBe('')
  expect([p.a, p.b, p.c]).not.toContain('')
  expect(new Set([p.a, p.b, p.c]).size).toBe(3)
  const q = at('e && f | g && h')
  expect([q.e, q.h]).toEqual(['', ''])
  expect(q.f).not.toBe('')
  expect(q.g).not.toBe('')
  expect(q.g).not.toBe(q.f)
  // A newline after `|` continues the pipeline. A newline after a part ends it.
  const n = at('i |\nj\nk')
  expect([n.i, n.j]).not.toContain('')
  expect(n.i).not.toBe(n.j)
  expect(n.k).toBe('')
})

test('splitShell keeps a whole group, loop or subshell in one pipeline part', () => {
  const g = at('{ a; b; } | c; d')
  expect(g.a).not.toBe('')
  expect(g.b).toBe(g.a)
  expect(g.c).not.toBe(g.a)
  expect(g.d).toBe('')
  const l = at('for i in 1; do a; done | x; y')
  expect(l['for i in 1']).not.toBe('')
  expect(l['do a']).toBe(l['for i in 1'])
  expect(l.done).toBe(l['for i in 1'])
  expect(l.x).not.toBe(l['for i in 1'])
  expect(l.y).toBe('')
  // The head of a compound holds a pipeline of its own: `if a | b; then c; fi`.
  const c = at('if a | b; then c; fi | q; r')
  expect(c['if a']).not.toBe(c.b)
  expect(c.fi).toBe(c['then c'])
  expect(c.q).not.toBe(c.fi)
  expect(c.r).toBe('')
  // A part of a subshell or a substitution is a child of that subshell.
  const s = at('( s | t ); u')
  expect(s.s?.startsWith('.1.')).toBe(true)
  expect(s.t?.startsWith('.1.')).toBe(true)
  expect(s.s).not.toBe(s.t)
  expect(s.u).toBe('')
  const b = at('V=`v | w`; z')
  expect(b.v?.startsWith('.1.')).toBe(true)
  expect(b.w?.startsWith('.1.')).toBe(true)
  expect(b.v).not.toBe(b.w)
  expect(b.z).toBe('')
})

test('splitShell reads >| as a redirection, not a pipe', () => {
  expect(at('a >| f; b')).toEqual({ a: '', b: '' })
  expect(at('a 2>| f | b').a).not.toBe('')
})

// An escaped `>` is a word, so the `|` after it is a pipe. After an escaped backslash the `>` is typed again.
test('splitShell reads a | after an escaped > as a pipe', () => {
  const e = at('a \\>| b; c')
  expect([e.a, e.b]).not.toContain('')
  expect(e.a).not.toBe(e.b)
  expect(e.c).toBe('')
  expect(Object.values(at('a \\\\>| b'))).toEqual([''])
})

// The `)` of a pattern ends no subshell (issue #148), so a `cd` in an arm stays in the subshell around the `case`.
test('splitShell keeps a case arm in the subshell around the case', () => {
  const a = at('( case x in x) a ;; esac ); b')
  expect([a.a, a.b]).toEqual(['.1', ''])
  // Two arms, an alternation, `;&` and `;;&`.
  const m = at('( case x in y) c ;; a|x) d ;& z) e ;;& esac ); f')
  expect([m.c, m.d, m.e, m.f]).toEqual(['.1', '.1', '.1', ''])
  // A `case` in a `case`: the inner `esac` leaves the outer arm open.
  const n = at('( case x in x) case y in y) g ;; esac; h ;; esac ); i')
  expect([n.g, n.h, n.i]).toEqual(['.1', '.1', ''])
  // A `(` in front of a pattern opens no scope: the next `(` after the pattern does.
  const p = at('( case x in (x) a ;; (y|z) b ;; esac ); c')
  expect([p.a, p.b, p.c]).toEqual(['.1', '.1', ''])
  const q = at('case x in\n (x) ( a ) ;; (y) ( b ) ;; esac; c')
  expect([q.a, q.b, q.c]).toEqual(['.1', '.2', ''])
  // A subshell or a substitution in an arm closes at its own `)`.
  const s = at('case x in x) ( j ); k ;; esac')
  expect([s.j, s.k]).toEqual(['.1', ''])
  const t = at('case $(o) in x) p ;; esac')
  expect([t.o, t.p]).toEqual(['.1', ''])
  // `esac` ends the case: the `)` of a subshell after it closes that subshell.
  const e = at('case x in x) : ;; esac; ( l ); m; n')
  expect([e.l, e.m, e.n]).toEqual(['.1', '', ''])
})

// `esac` can stand right after a compound with no `;;`. `fi esac` and `done esac` close two compounds, and a compound
// that ends a pipeline part ends the pipeline before the `esac` gives back the place of the `case`.
test('splitShell ends the case and the pipeline at an esac that follows a compound', () => {
  const a = at('( case x in x) if :; then a; fi esac ); b')
  expect([a['then a'], a.b]).toEqual(['.1', ''])
  const d = at('( case x in x) for i in 1; do c; done esac ); e')
  expect([d['do c'], d.e]).toEqual(['.1', ''])
  const p = at('case x in x) echo hi | { f; } esac; g')
  expect(p.f).not.toBe('')
  expect(p.g).toBe('')
})

// Only the `in` of the case header makes a `(` a pattern start. A word `in` at the end of an arm does not.
test('splitShell opens a subshell after a line that ends with the word in', () => {
  const a = at('case x in x) echo logged in\n( a ); b ;; esac')
  expect([a.a, a.b]).toEqual(['.1', ''])
  // The header `case $(o) in` is two segments, so its lone `in` starts a pattern: `(x)` opens no scope, and `( c )` is `.2`.
  const h = at('case $(o) in\n(x) ( c ) ;; esac; d')
  expect([h.o, h.c, h.d]).toEqual(['.1', '.2', ''])
})

// The last part of a pipeline ends with the command, as a part ends at `;`.
test('splitShell gives the last part of a command that ends with a pipeline a scope of its own', () => {
  const p = at('a | b')
  expect(p.a).not.toBe('')
  expect(p.b).not.toBe('')
  expect(p.b).not.toBe(p.a)
})

// A part that holds only a subshell has scopes of its own, and a wrapper scope with no segment changes nothing. So the
// scope ids of nested pipelines stay as deep as the brackets (each `)` would relabel every inner segment otherwise).
test('splitShell adds no scope level for a pipeline part that holds only a subshell', () => {
  const n = 12
  const segs = splitShell('( cat | '.repeat(n) + 'cd /x' + ' )'.repeat(n))
  const depth = Math.max(...segs.map(s => s.scope.split('.').length - 1))
  expect(depth).toBeLessThanOrEqual(n + 1)
})

test('splitShell takes a stray ) } or done as it comes, with no scope or compound open', () => {
  expect(Object.keys(at(') a } | b ) c; done; d'))).toEqual(['a', 'b', 'c', 'done', 'd'])
  expect(Object.values(at('a ) b; done'))).toEqual(['', '', ''])
})
