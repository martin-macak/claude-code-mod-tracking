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
  // The escaped `>` stays a word of the first segment (`a >`), so the segment is named by it.
  const e = at('a \\>| b; c')
  expect(Object.keys(e)).toEqual(['a >', 'b', 'c'])
  expect([e['a >'], e.b]).not.toContain('')
  expect(e['a >']).not.toBe(e.b)
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

// A `}` right before the closing backtick ends its group, as it does before `;` or `)` (issue #161). Else the group
// stays open, and the `}` that comes later closes the wrong place.
test('splitShell ends a group at a } right before a closing backtick', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  expect(words('{ echo `cd /x; { a; }`; } & b')).toEqual(['echo', 'cd /x', 'a', 'b'])
  // The `&` backgrounds the whole outer group, so the `cd` in front of the backtick leaves the top scope.
  const t = at('{ cd /y; echo `{ a; }`; } & b')
  expect(t['cd /y']).not.toBe('')
  expect(t.b).toBe('')
  // A group in a backtick runs in the scope of the backtick.
  expect(at('echo `cd /x; { a; }`; b')).toEqual({ echo: '', 'cd /x': '.1', a: '.1', b: '' })
})

// A `}` right before an opening backtick is part of a word (`}x`), so it closes no group.
test('splitShell reads a } before an opening backtick as a word', () => {
  expect(splitShell('echo }`x`; y').map(s => s.words.join(' '))).toEqual(['echo }', 'x', 'y'])
})

// Only a `>` that was typed, with no quote and no backslash, is a redirection (issue #162). A quoted or escaped one is
// a word, and so is the word after it.
test('splitShell keeps a quoted or escaped redirection word and the word after it', () => {
  const words = (cmd: string) => splitShell(cmd)[0]?.words
  expect(words('printf x \\> git -C /repo status')).toEqual(['printf', 'x', '>', 'git', '-C', '/repo', 'status'])
  // The detached form of the issue: the name of the process is what stands after the wrappers.
  expect(stripLead(words('nohup printf x \\> out.txt &')!).words).toEqual(['printf', 'x', '>', 'out.txt'])
  expect(words("echo '>' a")).toEqual(['echo', '>', 'a'])
  expect(words('echo ">" a')).toEqual(['echo', '>', 'a'])
  expect(words("echo '>>' a")).toEqual(['echo', '>>', 'a'])
  expect(words('echo \\< a')).toEqual(['echo', '<', 'a'])
  expect(words("echo '>' >f a")).toEqual(['echo', '>', 'a'])
  // The other characters of the word do not make a redirection of it: `>f`, `2>&1`, `>|`, `&>`, a quoted `2`.
  expect(words('echo \\>f a')).toEqual(['echo', '>f', 'a'])
  expect(words('echo 2\\>\\&1 a')).toEqual(['echo', '2>&1', 'a'])
  expect(words('echo "2>&1" a')).toEqual(['echo', '2>&1', 'a'])
  expect(words('echo ">|" a')).toEqual(['echo', '>|', 'a'])
  expect(words("echo '&>' a")).toEqual(['echo', '&>', 'a'])
  expect(words("echo '2'\\> a")).toEqual(['echo', '2>', 'a'])
  // A typed character after the quote or the escape does not bring the word back: `'>'f` is the word `>f`.
  expect(words("echo '>'f a")).toEqual(['echo', '>f', 'a'])
  expect(words('echo ">"f a')).toEqual(['echo', '>f', 'a'])
})

test('splitShell still drops a typed redirection and its target', () => {
  const words = (cmd: string) => splitShell(cmd)[0]?.words
  expect(words('echo a > f b')).toEqual(['echo', 'a', 'b'])
  expect(words('echo a >f b')).toEqual(['echo', 'a', 'b'])
  expect(words('echo a >> f b')).toEqual(['echo', 'a', 'b'])
  expect(words('echo a 2> f b')).toEqual(['echo', 'a', 'b'])
  expect(words('echo a 2>&1 b')).toEqual(['echo', 'a', 'b'])
  expect(words('echo a &>f b')).toEqual(['echo', 'a', 'b'])
  expect(words('echo a < f b')).toEqual(['echo', 'a', 'b'])
  expect(words('echo a >| f b')).toEqual(['echo', 'a', 'b'])
  // A target that was quoted or escaped belongs to the redirection.
  expect(words('echo a > "f g" b')).toEqual(['echo', 'a', 'b'])
  expect(words("echo a > '>' b")).toEqual(['echo', 'a', 'b'])
  expect(words('echo a >\\> b')).toEqual(['echo', 'a', 'b'])
  expect(words("echo a >'>' b")).toEqual(['echo', 'a', 'b'])
  // An empty quote glued to the `>` is the target, and adds no character to the word: the next word stays.
  expect(words("echo a >'' b")).toEqual(['echo', 'a', 'b'])
  expect(words('echo a >"" b')).toEqual(['echo', 'a', 'b'])
})

// The `&` of `>&` and `2>&1` belongs to a redirection only after a typed `>` or `<`. After a quoted or escaped one it is
// the background operator, as in bash.
test('splitShell reads a & after a quoted or escaped > as a background operator', () => {
  const segs = (cmd: string) => splitShell(cmd).map(s => `${s.words.join(' ')}${s.bg ? ' &' : ''}`)
  expect(segs("echo a '>'& echo b")).toEqual(['echo a > &', 'echo b'])
  expect(segs('echo a \\>& echo b')).toEqual(['echo a > &', 'echo b'])
  expect(segs('echo a \\<& echo b')).toEqual(['echo a < &', 'echo b'])
  expect(segs('echo a 2>&1 & echo b')).toEqual(['echo a &', 'echo b'])
  // A typed `>` with a quoted target is a redirection, and the `&` right after the target is a background operator.
  expect(segs("echo >'x'& echo b")).toEqual(['echo &', 'echo b'])
  expect(segs('echo a >&2; echo b')).toEqual(['echo a', 'echo b'])
  expect(segs('echo a <&0; echo b')).toEqual(['echo a', 'echo b'])
})

// A case pattern is never a command (issue #163). Its words stand in no segment, so `cd)` moves no folder and `if)`,
// `for)` or `done)` open or close no compound.
test('splitShell reads a case pattern as no command', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  expect(words('case x in y) :;; cd) :;; esac; git -C . status')).toEqual([
    'case x in',
    ':',
    ':',
    'esac',
    'git -C . status',
  ])
  // An alternation, a `(` in front, a keyword, a pattern on the line of the header or on the next.
  expect(words('case x in a|cd) b ;; (cd|c) d ;; esac')).toEqual(['case x in', 'b', 'd', 'esac'])
  expect(words('case x in if) a ;; for|done) b ;; (fi) c ;; esac; d')).toEqual([
    'case x in',
    'a',
    'b',
    'c',
    'esac',
    'd',
  ])
  expect(words('case x in\n cd) a ;;\n done) b ;;\n esac')).toEqual(['case x in', 'a', 'b', 'esac'])
  expect(words('case x\nin cd) a ;; esac')).toEqual(['case x', 'a', 'esac'])
  expect(words('case $(o) in cd) a ;; esac; b')).toEqual(['case', 'o', 'a', 'esac', 'b'])
  // No white space between `in` or `;;` and the `(` in front of a pattern.
  expect(words('case x in(x) a ;;(y) b ;; esac; c')).toEqual(['case x in', 'a', 'b', 'esac', 'c'])
  // A pattern keeps its quotes and its glob characters, and the arm after it is a list of its own.
  expect(words('case x in \'a b\'|"c"|*.ts) a ;; esac')).toEqual(['case x in', 'a', 'esac'])
})

// Bash reads `esac` as the end of the case when it comes first in the pattern position (`case x in esac` is an empty
// case, and `esac)` there is a syntax error). Behind `(` or `|` it is a pattern.
test('splitShell ends a case at an esac in the pattern position and reads it as a pattern behind ( or |', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  expect(words('case x in\nesac; a')).toEqual(['case x in', 'esac', 'a'])
  expect(words('case x in x) a ;; esac; b')).toEqual(['case x in', 'a', 'esac', 'b'])
  expect(words('case x in x) a ;; esac | b')).toEqual(['case x in', 'a', 'esac', 'b'])
  expect(words('case x in a|esac) b ;; (esac) c ;; esac; d')).toEqual(['case x in', 'b', 'c', 'esac', 'd'])
  expect(words('( case x in x) a ;; esac ); b')).toEqual(['case x in', 'a', 'esac', 'b'])
})

// A keyword is a keyword only as typed: `'esac'`, `"esac"` and `\esac` are patterns, so they end no case (the folder
// differential found a regression against main here). The `esac` that really ends it comes later.
test('splitShell reads a quoted or escaped esac in the pattern position as a pattern', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  expect(words("case x in 'esac') a ;; esac; b")).toEqual(['case x in', 'a', 'esac', 'b'])
  expect(words('case x in "esac"|\\esac) a ;; esac; b')).toEqual(['case x in', 'a', 'esac', 'b'])
  expect(words("case x in e'sac') a ;; esac; b")).toEqual(['case x in', 'a', 'esac', 'b'])
  // An empty quote makes the word a pattern too, though it adds no character to it: `esac''` is not `esac`.
  expect(words("case x in esac'') a ;; esac; b")).toEqual(['case x in', 'a', 'esac', 'b'])
  expect(words('case x in esac"") a ;; esac; b')).toEqual(['case x in', 'a', 'esac', 'b'])
  // The pattern `esac` ends no subshell around the case, so a `cd` in the arm stays in it.
  const r = at("( case x in 'esac') cd /x ;; esac ); b")
  expect([r['cd /x'], r.b]).toEqual(['.1', ''])
  // The `&` after the `esac` backgrounds the whole case.
  const g = at("case x in 'esac') cd /x ;; esac & b")
  expect(g['cd /x']).not.toBe('')
  expect(g.b).toBe('')
})

// A reserved word is one only as typed: a command named `'case'`, `"case"` or `\case` opens no case, so the commands after
// it are not pattern words and are not dropped (Codex review of this PR).
test('splitShell reads a quoted or escaped case as a command, not as a compound', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  expect(words("'case' x in; a")).toEqual(['case x in', 'a'])
  expect(words('"case" x in; a')).toEqual(['case x in', 'a'])
  expect(words('\\case x in; a')).toEqual(['case x in', 'a'])
  expect(words("c'a'se x in; a")).toEqual(['case x in', 'a'])
  // Also behind a typed lead word, and for a quoted lead word.
  expect(words("if 'case' x in; a")).toEqual(['if case x in', 'a'])
  expect(words("while 'case' x in; do a; done; b")).toEqual(['while case x in', 'do a', 'done', 'b'])
  // The typed forms still open a case, behind each lead word: its pattern words are dropped.
  expect(words('case x in y) a ;; esac; b')).toEqual(['case x in', 'a', 'esac', 'b'])
  expect(words('time -p case x in y) a ;; esac; b')).toEqual(['time -p case x in', 'a', 'esac', 'b'])
  expect(words('! case x in y) a ;; esac; b')).toEqual(['! case x in', 'a', 'esac', 'b'])
  expect(words('if case x in y) a ;; esac; then b; fi')).toEqual(['if case x in', 'a', 'esac', 'then b', 'fi'])
})

// A pattern word opens or closes no compound, so the case stays one unit: the `&` after `esac` backgrounds all of it.
test('splitShell opens and closes no compound for a case pattern word', () => {
  const p = at('case x in if) a ;; while|done) b ;; (fi) c ;; esac & d')
  expect([p.a, p.b, p.c].every(s => s !== '')).toBe(true)
  expect(new Set([p.a, p.b, p.c]).size).toBe(1)
  expect(p.d).toBe('')
  // A pattern `done` does not close the `for` that holds the case.
  const q = at('for i in 1; do case x in done) a ;; esac; b; done & c')
  expect([q.a, q.b].every(s => s !== '')).toBe(true)
  expect(q.c).toBe('')
  // A pattern `esac` behind `|` does not close the case, so the arm after it stays in the case.
  const r = at('( case x in a|esac) cd /x ;; esac ); b')
  expect([r['cd /x'], r.b]).toEqual(['.1', ''])
  // A `|` between patterns is no pipe, so no segment moves to a child scope. Neither does the pipe in an arm move the header.
  expect(Object.values(at('case x in a|b) c ;; (d|e) f ;; esac; g'))).toEqual(['', '', '', '', ''])
  expect(at('case x in x) a | b ;; esac; c')['case x in']).toBe('')
  // A pattern `{` or `}` opens or closes no group, so the `}` at the end still closes the group that the `&` backgrounds.
  const g = at('{ cd /y; case x in x) a ;; {) b ;; esac; c; } & d')
  expect([g['cd /y'], g.a, g.b, g.c].every(v => v !== '')).toBe(true)
  expect(g.d).toBe('')
  const h = at('{ cd /y; case x in x) a ;; }) b ;; esac; c; } & d')
  expect([h['cd /y'], h.a, h.b, h.c].every(v => v !== '')).toBe(true)
  expect(h.d).toBe('')
})

// A `)` in an arm, with no `(` before it, is no valid shell. It ends no subshell: only the `)` that closes one does.
test('splitShell takes a stray ) in a case arm as no end of a subshell', () => {
  const s = at('( case x in x) a ) ; b ;; esac ); c')
  expect([s.a, s.b, s.c]).toEqual(['.1', '.1', ''])
})

// A compound at the start of a condition opens a level of its own (issue #163): `if for ...; done; then` has two open
// compounds, so its `done` closes the `for` and its `fi` closes the `if`.
test('splitShell opens a compound of its own at the start of a condition', () => {
  // The segment is found by its exact words, and the test fails when it is missing: a lookup that returns `undefined`
  // would pass `!== ''` with no behavior behind it.
  const scopeOf = (cmd: string, name: string): string => {
    const hit = splitShell(cmd).find(s => s.words.join(' ') === name)
    expect(hit).toBeDefined()
    return hit!.scope
  }
  // Each named segment sits in the background unit, and `z` after the `&` does not.
  const inUnit = (cmd: string, ...names: string[]) => {
    for (const n of names) expect(scopeOf(cmd, n)).not.toBe('')
    expect(scopeOf(cmd, 'z')).toBe('')
  }
  inUnit('if for i in 1; do a; done; then b; fi & z', 'do a', 'then b')
  inUnit('while for i in 1; do a; done; do b; break; done & z', 'do a', 'do b')
  inUnit('until if a; then b; fi; do c; done & z', 'then b', 'do c')
  inUnit('if if a; then b; fi; then c; fi & z', 'then b', 'then c')
  inUnit('if ! time for i in 1; do a; done; then b; fi & z', 'do a', 'then b')
  inUnit('if case x in x) a ;; esac; then b; fi & z', 'a', 'then b')
  inUnit('if :; then :; elif for i in 1; do a; done; then b; fi & z', 'do a', 'then b')
  inUnit('for i in 1; do if for j in 1; do a; done; then b; fi; done & z', 'do a', 'then b')
  // The same through a pipe: the whole `if` is one pipeline part, and `z` is the next part.
  const p = 'if for i in 1; do a; done; then b; fi | z'
  expect(scopeOf(p, 'do a')).not.toBe('')
  expect(scopeOf(p, 'then b')).toBe(scopeOf(p, 'do a'))
  expect(scopeOf(p, 'z')).not.toBe(scopeOf(p, 'do a'))
  expect(scopeOf(p, 'z')).not.toBe('')
})

// A here-string (`<<<`) takes one word, as `<` takes a file (issue #182). The line after it is a new command. The splitter
// read the `<<` inside `<<<` as a heredoc and skipped the lines up to a tag line that never came.
test('splitShell reads a here-string as a redirection with one word, so the next line is a command', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const rest = ['cd /x', 'git -C . status']
  expect(words('cat <<< hi\ncd /x\ngit -C . status')).toEqual(['cat', ...rest])
  expect(words('cat <<<hi\ncd /x\ngit -C . status')).toEqual(['cat', ...rest])
  expect(words('jq . <<<"$j"\ncd /x\ngit -C . status')).toEqual(['jq .', ...rest])
  // The word can be quoted, spaced or glued, and it can look like a heredoc tag.
  expect(words('cat <<< "a b"\ncd /x\ngit -C . status')).toEqual(['cat', ...rest])
  expect(words("cat <<<'a b'\ncd /x\ngit -C . status")).toEqual(['cat', ...rest])
  expect(words('cat <<<EOF\ncd /x\nEOF\ngit -C . status')).toEqual(['cat', 'cd /x', 'EOF', 'git -C . status'])
  expect(words("cat <<< 'EOF'\ncd /x\ngit -C . status")).toEqual(['cat', ...rest])
  // A file descriptor in front, two here-strings in one command, and a substitution as the word.
  expect(words('cat 3<<<hi\ncd /x\ngit -C . status')).toEqual(['cat', ...rest])
  expect(words('cat <<< x <<< y\ncd /x\ngit -C . status')).toEqual(['cat', ...rest])
  expect(words('cat <<<$(echo hi)\ncd /x\ngit -C . status')).toEqual(['cat', 'echo hi', ...rest])
  // The words around it stay: only the redirection and its word go.
  expect(words('grep a <<< hi b\ncd /x')).toEqual(['grep a b', 'cd /x'])
  expect(words('grep a <<<hi b\ncd /x')).toEqual(['grep a b', 'cd /x'])
  // Other operators after it work as usual.
  expect(words('cat <<< hi; cd /x; git -C . status')).toEqual(['cat', ...rest])
  expect(words('cat <<< hi && cd /x\ngit -C . status')).toEqual(['cat', ...rest])
  expect(words('cat <<< hi | wc\ncd /x')).toEqual(['cat', 'wc', 'cd /x'])
  // Glued to the word before it, the here-string stays in that word (a KB limit). The lines after it are commands.
  expect(words('cat<<<hi\ncd /x\ngit -C . status')).toEqual(['cat<<<hi', ...rest])
})

// A heredoc has the same first characters as a here-string. Each form that the splitter knows still hides its body, and the
// command after the tag line is read. An escaped `<` in front is a word, so the `<<` after it is a heredoc. An escaped tag
// (`<<\EOF`) and a file descriptor in front (`3<<EOF`) are KB limits, not forms of this test.
test('splitShell still skips the body of every form of heredoc that it knows', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const body = 'cd /y\nEOF\ncd /x'
  expect(words(`cat <<EOF\n${body}`)).toEqual(['cat', 'cd /x'])
  expect(words(`cat << EOF\n${body}`)).toEqual(['cat', 'cd /x'])
  expect(words(`cat <<'EOF'\n${body}`)).toEqual(['cat', 'cd /x'])
  expect(words(`cat <<"EOF"\n${body}`)).toEqual(['cat', 'cd /x'])
  expect(words('cat <<-EOF\n\tcd /y\n\tEOF\ncd /x')).toEqual(['cat', 'cd /x'])
  // Another command on the line of the heredoc, a redirection after it, two heredocs.
  expect(words(`cat <<EOF; echo a\n${body}`)).toEqual(['cat', 'echo a', 'cd /x'])
  expect(words(`cat <<EOF > f\n${body}`)).toEqual(['cat', 'cd /x'])
  expect(words('cat <<A <<B\ncd /y\nA\ncd /z\nB\ncd /x')).toEqual(['cat', 'cd /x'])
  expect(words(`echo \\<<<EOF\n${body}`)).toEqual(['echo <', 'cd /x'])
})

// A heredoc and a here-string on one line: the here-string takes its word, and the heredoc still hides its body.
test('splitShell reads a here-string and a heredoc on one line', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const body = 'cd /y\nEOF\ncd /x'
  expect(words(`cat <<< hi <<EOF\n${body}`)).toEqual(['cat', 'cd /x'])
  expect(words(`cat <<<hi <<EOF\n${body}`)).toEqual(['cat', 'cd /x'])
  expect(words(`cat <<EOF <<< hi\n${body}`)).toEqual(['cat', 'cd /x'])
  expect(words(`cat <<EOF <<<hi\n${body}`)).toEqual(['cat', 'cd /x'])
})

// `<>` opens a file for reading and writing, and `n<>` does the same on a file descriptor. They are redirections, as `<`
// and `>` are, and their target goes with them (issue #183).
test('splitShell drops <> and n<> with their target', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  expect(words('cmd <> f; git status')).toEqual(['cmd', 'git status'])
  expect(words('exec 3<> lock; git -C /y status')).toEqual(['exec', 'git -C /y status'])
  // The target glued, quoted or escaped, and the words around it.
  expect(words('cmd a <>f b')).toEqual(['cmd a b'])
  expect(words('cmd a 3<>f b')).toEqual(['cmd a b'])
  expect(words('cmd a <> "f g" b')).toEqual(['cmd a b'])
  expect(words("cmd a <>'f g' b")).toEqual(['cmd a b'])
  expect(words('cmd a 4<> \\> b')).toEqual(['cmd a b'])
  expect(words("cmd a <>'' b")).toEqual(['cmd a b'])
  expect(words('cmd a 3<>f 4<> g b')).toEqual(['cmd a b'])
  // Operators after the target work as usual.
  expect(words('cmd <> f && a\nb | c')).toEqual(['cmd', 'a', 'b', 'c'])
  expect(words('cmd <>f & a')).toEqual(['cmd', 'a'])
  // A quoted or escaped `<>` is a word, and so is the word after it.
  expect(words("echo '<>' a")).toEqual(['echo <> a'])
  expect(words('echo "<>" a')).toEqual(['echo <> a'])
  expect(words('echo "3<>f" a')).toEqual(['echo 3<>f a'])
  expect(words("echo '<>'f a")).toEqual(['echo <>f a'])
})

// Only an unquoted, unescaped `done`, `fi` or `esac` closes a compound (issue #184). Bash reads any other spelling as a
// command of that name, so the compound goes on, and so does the pipeline or the list that holds it.
test('splitShell reads a quoted or escaped done, fi or esac as a command, not as the end of a compound', () => {
  // A quoted `done` leaves the loop open, so the loop stays one part of the pipeline: its `cd /x` runs in the subshell.
  const loop = { 'for i in 1': '.1', 'do cd /x': '.1', 'done y': '.1', done: '.1', cat: '.2', z: '' }
  for (const q of ["'done'", '"done"', '\\done', "d'on'e", 'd\\one', "done''", 'done""', "''done"])
    expect(at(`for i in 1; do cd /x; ${q} y; done | cat; z`)).toEqual(loop)
  // The same for `fi` and `esac`, in the middle of a branch or an arm.
  const ifs = { 'if true': '.1', 'then :': '.1', 'fi y': '.1', 'cd /x': '.1', fi: '.1', cat: '.2', z: '' }
  for (const q of ["'fi'", '"fi"', '\\fi', "f'i'", "fi''"])
    expect(at(`if true; then :; ${q} y; cd /x; fi | cat; z`)).toEqual(ifs)
  const cases = { 'case x in': '.1', 'esac y': '.1', 'cd /x': '.1', esac: '.1', cat: '.2', z: '' }
  for (const q of ["'esac'", '"esac"', '\\esac', "e'sac'", "esac''"])
    expect(at(`case x in x) ${q} y; cd /x ;; esac | cat; z`)).toEqual(cases)
  // The loop still ends at its real `done`: the `&` after it backgrounds the whole loop, the `cd` after the quoted word too.
  const bg = at("a; for i in 1; do cd /x; 'done' y; cd /y; done & z")
  expect([bg['do cd /x'], bg['cd /y'], bg.z]).toEqual(['.1', '.1', ''])
  // A quoted `done` closes no inner loop, so the real ones close the inner and then the outer loop.
  const nested = at("for i in 1; do for j in 1; do :; 'done' y; cd /x; done; cd /y; done | cat; z")
  expect([nested['cd /x'], nested['cd /y'], nested.z]).toEqual(['.1', '.1', ''])
  // A typed `done` still closes, and a word that only starts like one is no close.
  expect(at('for i in 1; do cd /x; done | cat; z')).toEqual({
    'for i in 1': '.1',
    'do cd /x': '.1',
    done: '.1',
    cat: '.2',
    z: '',
  })
  expect(at('for i in 1; do cd /x; doner; done | cat; z').doner).toBe('.1')
})
