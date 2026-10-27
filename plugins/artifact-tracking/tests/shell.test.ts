import { expect, test } from 'claude-code/testing'
import { keepsStdout, scopedCopy, splitShell, stripLead, stripReserved, stripWrappers } from '../core/lib/shell'
import { expectLinear } from './fixtures/scaling'

/**
 * The words of a command that was typed whole, with no redirection among them: `stripLead` takes the typed flags of its
 * words (issue #194) and the redirection flags (issue #227).
 */
const typed = (words: string[]) => ({ words, whole: words.map(() => true), redir: words.map(() => false) })

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
  expect(stripLead(typed(['time', '!', ...cmd])).words).toEqual(cmd)
  expect(stripLead(typed(['!', 'time', ...cmd])).words).toEqual(cmd)
  expect(stripLead(typed(['if', 'time', '!', 'sudo', ...cmd])).words).toEqual(cmd)
  expect(stripLead(typed(['do', 'time', 'nohup', '!', ...cmd])).words).toEqual(cmd)
})

// bash reads `time -p` and `time --` as one prefix: the options belong to `time`, not to the command (issue #227).
// `compoundLead` already skips them. `command`, `exec` and `builtin` keep their own rule: `command -v acli` runs nothing.
test('stripWrappers drops the options of time together with it', () => {
  const cmd = ['git', '-C', '/tmp/r', 'push']
  expect(stripWrappers(['time', '-p', ...cmd]).words).toEqual(cmd)
  expect(stripWrappers(['time', '--', ...cmd]).words).toEqual(cmd)
  expect(stripWrappers(['time', '-p', '--', ...cmd]).words).toEqual(cmd)
  expect(stripWrappers(['time', '-p', 'sudo', '-u', 'root', ...cmd]).words).toEqual(cmd)
  expect(stripWrappers(['time', '-p', 'time', '-p', ...cmd]).words).toEqual(cmd)
})

// Bash gives `time` only `-p`, then `--`, each at most once. Any other word is the command: `time -x git push` runs a
// command named `-x` and starts nothing, so a reader must not see `git push` (issue #227).
test('stripWrappers gives time only -p and then --, each once: any other word is the command', () => {
  expect(stripWrappers(['time', '-x', 'git', 'push']).words).toEqual(['-x', 'git', 'push'])
  expect(stripWrappers(['time', '-p', '-x', 'git', 'push']).words).toEqual(['-x', 'git', 'push'])
  expect(stripWrappers(['time', '-p', '-p', 'git', 'push']).words).toEqual(['-p', 'git', 'push'])
  expect(stripWrappers(['time', '--', '-p', 'git', 'push']).words).toEqual(['-p', 'git', 'push'])
  expect(stripWrappers(['time', '--', '--', 'git', 'push']).words).toEqual(['--', 'git', 'push'])
})

test('stripWrappers drops only the options right behind time', () => {
  expect(stripWrappers(['time', 'git', '-p', 'push']).words).toEqual(['git', '-p', 'push'])
  expect(stripWrappers(['git', 'time', '-p'])).toEqual({ words: ['git', 'time', '-p'], env: {}, nohup: false })
  expect(stripWrappers(['time', '-p'])).toEqual({ words: [], env: {}, nohup: false })
})

// Bash reads an option of `time` only when it was typed whole: `time "-p" printf ok` fails with `-p: command not found`.
// A quoted or escaped `-p` or `--` is the command (Codex review of the PR). The flags are those of `Segment.whole`.
test('stripWrappers reads a quoted or escaped option of time as the command', () => {
  const cmd = ['git', 'push']
  expect(stripWrappers(['time', '-p', ...cmd], [true, false, true, true]).words).toEqual(['-p', ...cmd])
  expect(stripWrappers(['time', '--', ...cmd], [true, false, true, true]).words).toEqual(['--', ...cmd])
  // The typed `-p` goes, the quoted `--` after it is the command.
  expect(stripWrappers(['time', '-p', '--', ...cmd], [true, true, false, true, true]).words).toEqual(['--', ...cmd])
  // A word that is only partly quoted (`-"p"`) is not whole either.
  const partly = stripWrappers(['time', '-p', '--', ...cmd], [true, false, true, true, true])
  expect(partly.words).toEqual(['-p', '--', ...cmd])
  // The controls: a typed option goes, and so does a word with no flag at all.
  expect(stripWrappers(['time', '-p', '--', ...cmd], [true, true, true, true, true]).words).toEqual(cmd)
  expect(stripWrappers(['time', '-p', '--', ...cmd]).words).toEqual(cmd)
})

test('stripLead reads a quoted or escaped option of time as the command', () => {
  const words = (command: string) => stripLead(splitShell(command)[0]!).words
  expect(words('time "-p" git push')).toEqual(['-p', 'git', 'push'])
  expect(words("time '-p' git push")).toEqual(['-p', 'git', 'push'])
  expect(words('time \\-p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time -"p" git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time "--" git push')).toEqual(['--', 'git', 'push'])
  expect(words('time -p "--" git push')).toEqual(['--', 'git', 'push'])
  expect(words('time -p \\-- git push')).toEqual(['--', 'git', 'push'])
  // The flags follow the words through the reserved words in front of `time`.
  expect(words('! time "-p" git push')).toEqual(['-p', 'git', 'push'])
  expect(words('if ! time "-p" git push; then :; fi')).toEqual(['-p', 'git', 'push'])
  // The controls: typed options still go.
  expect(words('time -p -- git push')).toEqual(['git', 'push'])
  expect(words('! time -p git push')).toEqual(['git', 'push'])
})

// Bash reads an option of `time` only when nothing stands between it and `time` or the option before it. A redirection
// does: `time >/dev/null -p printf ok` fails with `-p: command not found` (bash 3.2 and 5.3, Codex review of the PR).
// `splitShell` drops the redirection from `words`, so `Segment.redir` says that one stood right before a word.
test('splitShell marks each word that stands right behind a redirection', () => {
  const redirOf = (command: string) => splitShell(command)[0]!.redir
  expect(redirOf('time >/dev/null -p git push')).toEqual([false, true, false, false])
  expect(redirOf('time > /dev/null -p git push')).toEqual([false, true, false, false])
  expect(redirOf('time -p >/dev/null -- git push')).toEqual([false, false, true, false, false])
  expect(redirOf('time 2>&1 -p git push')).toEqual([false, true, false, false])
  expect(redirOf('time </dev/null -p git push')).toEqual([false, true, false, false])
  expect(redirOf('time <<<x -p git push')).toEqual([false, true, false, false])
  expect(redirOf('time {fd}>/dev/null -p git push')).toEqual([false, true, false, false])
  expect(redirOf('time &>/dev/null -p git push')).toEqual([false, true, false, false])
  expect(redirOf('time >/dev/null 2>&1 -p git push')).toEqual([false, true, false, false])
  expect(redirOf('time >"/tmp/a b" -p git push')).toEqual([false, true, false, false])
  // A heredoc leaves no word, so the scanner marks the word behind it. So does a file descriptor in front of it.
  expect(redirOf('time <<EOF -p git push\nbody\nEOF')).toEqual([false, true, false, false])
  expect(redirOf("time <<-'EOF' -p git push\nbody\nEOF")).toEqual([false, true, false, false])
  expect(redirOf('time 3<<EOF -p git push\nbody\nEOF')).toEqual([false, true, false, false])
  expect(redirOf('time {fd}<<EOF -p git push\nbody\nEOF')).toEqual([false, true, false, false])
  // The controls: no redirection, a redirection at the end, a quoted or escaped `>` (a word).
  expect(redirOf('time -p git push')).toEqual([false, false, false, false])
  expect(redirOf('time -p git push >/dev/null')).toEqual([false, false, false, false])
  expect(redirOf("time '>' -p git push")).toEqual([false, false, false, false, false])
  expect(redirOf('time \\> -p git push')).toEqual([false, false, false, false, false])
})

test('splitShell marks only the word right behind a redirection, and no word of the next segment', () => {
  expect(splitShell('git >/dev/null push -p')[0]!.redir).toEqual([false, true, false])
  // A heredoc on the line of a segment that ends with `;` does not mark the first word of the next segment.
  const segs = splitShell('cat <<EOF; time -p git push\nbody\nEOF')
  expect(segs.map(s => s.words)).toEqual([['cat'], ['time', '-p', 'git', 'push']])
  expect(segs.map(s => s.redir)).toEqual([[false], [false, false, false, false]])
  // A redirection at the end of a segment marks nothing in the next one either.
  const next = splitShell('time -p git push >/dev/null; time -p git status')
  expect(next[1]!.redir).toEqual([false, false, false, false])
})

test('stripWrappers reads a word behind a redirection as the command, not as an option of time', () => {
  const cmd = ['git', 'push']
  // Same length as the words: the flags of `time >/dev/null -p git push` once the redirection is dropped.
  expect(stripWrappers(['time', '-p', ...cmd], undefined, [false, true, false, false]).words).toEqual(['-p', ...cmd])
  expect(stripWrappers(['time', '--', ...cmd], undefined, [false, true, false, false]).words).toEqual(['--', ...cmd])
  // The typed `-p` goes, the `--` behind the redirection is the command.
  expect(stripWrappers(['time', '-p', '--', ...cmd], undefined, [false, false, true, false, false]).words).toEqual([
    '--',
    ...cmd,
  ])
  // A redirection behind the first `-p` does not touch it, and one in front of the command is no matter.
  expect(stripWrappers(['time', '-p', ...cmd], undefined, [false, false, true, false]).words).toEqual(cmd)
  expect(stripWrappers(['time', '-p', '--', ...cmd], undefined, [false, false, false, true, false]).words).toEqual(cmd)
  // The controls: no flag at all, and no redirection anywhere.
  expect(stripWrappers(['time', '-p', '--', ...cmd]).words).toEqual(cmd)
  expect(stripWrappers(['time', '-p', '--', ...cmd], undefined, [false, false, false, false, false]).words).toEqual(cmd)
  // A quote and a redirection both end the options.
  expect(
    stripWrappers(['time', '-p', '--', ...cmd], [true, true, true, true, true], [false, true, false, false, false])
      .words,
  ).toEqual(['-p', '--', ...cmd])
})

test('stripLead reads a word behind a redirection as the command, not as an option of time', () => {
  const words = (command: string) => stripLead(splitShell(command)[0]!).words
  // Both positions: the redirection stands right behind `time`, and right behind `-p`.
  expect(words('time >/dev/null -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time > /dev/null -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time >/dev/null -- git push')).toEqual(['--', 'git', 'push'])
  expect(words('time -p >/dev/null -- git push')).toEqual(['--', 'git', 'push'])
  expect(words('time -p 2>&1 -- git push')).toEqual(['--', 'git', 'push'])
  expect(words('time >/dev/null -p -- git push')).toEqual(['-p', '--', 'git', 'push'])
  // Every form of redirection: a file, a descriptor, an input, a here-string, `&>`, a heredoc, a variable descriptor.
  expect(words('time 2>&1 -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time </dev/null -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time <<<x -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time &>/dev/null -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time {fd}>/dev/null -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time <<EOF -p git push\nbody\nEOF')).toEqual(['-p', 'git', 'push'])
  expect(words('time 3<<EOF -p git push\nbody\nEOF')).toEqual(['-p', 'git', 'push'])
  expect(words('time -p <<EOF -- git push\nbody\nEOF')).toEqual(['--', 'git', 'push'])
  // The flags follow the words through the reserved words in front of `time`.
  expect(words('! time >/dev/null -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('if time 2>&1 -p git push; then :; fi')).toEqual(['-p', 'git', 'push'])
  // A redirection behind the options, in front of the command, is no matter: the options still go.
  expect(words('time -p >/dev/null git push')).toEqual(['git', 'push'])
  expect(words('time -p -- >/dev/null git push')).toEqual(['git', 'push'])
  expect(words('time >/dev/null git push')).toEqual(['git', 'push'])
  expect(words('time -p <<EOF git push\nbody\nEOF')).toEqual(['git', 'push'])
  expect(words('time -p git push >/dev/null')).toEqual(['git', 'push'])
  expect(words('time -p -- git push')).toEqual(['git', 'push'])
})

// Every other word that ends the options of `time` already ends them: the loop skips `-p` and `--` only right behind
// `time` and the option before it, and takes any other word as the command (bash 3.2 and 5.3).
test('stripLead ends the options of time at an assignment, a reserved word, a glued word or a new line', () => {
  const words = (command: string) => stripLead(splitShell(command)[0]!).words
  // An assignment: `time FOO=1 -p printf ok` runs a command named `-p` with `FOO=1` in its environment.
  expect(stripLead(splitShell('time FOO=1 -p git push')[0]!)).toEqual({
    words: ['-p', 'git', 'push'],
    env: { FOO: '1' },
    nohup: false,
  })
  expect(stripLead(splitShell('time -p FOO=1 git push')[0]!)).toEqual({
    words: ['git', 'push'],
    env: { FOO: '1' },
    nohup: false,
  })
  // A reserved word: `time ! -p printf ok` runs a command named `-p`, but `time -p ! printf ok` negates `printf`.
  expect(words('time ! -p git push')).toEqual(['-p', 'git', 'push'])
  expect(words('time -p ! git push')).toEqual(['git', 'push'])
  // Another `time`.
  expect(words('time time -p git push')).toEqual(['git', 'push'])
  expect(words('time -p time -p git push')).toEqual(['git', 'push'])
  expect(words('time -p -- time -p git push')).toEqual(['git', 'push'])
  // A word glued to the option is another word.
  expect(words('time -p-- git push')).toEqual(['-p--', 'git', 'push'])
  expect(words('time -pp git push')).toEqual(['-pp', 'git', 'push'])
  expect(words('time --p git push')).toEqual(['--p', 'git', 'push'])
  // A backslash and a new line join the lines: the option stays one.
  expect(words('time \\\n-p git push')).toEqual(['git', 'push'])
})

test('stripWrappers keeps the env and the nohup flag of what follows time -p', () => {
  expect(stripWrappers(['time', '-p', 'A=1', 'nohup', 'sleep', '9'])).toEqual({
    words: ['sleep', '9'],
    env: { A: '1' },
    nohup: true,
  })
})

test('stripWrappers and stripLead keep the options of command, exec and builtin', () => {
  expect(stripWrappers(['command', '-v', 'acli']).words).toEqual(['-v', 'acli'])
  expect(stripWrappers(['exec', '-c', 'git', 'push']).words).toEqual(['-c', 'git', 'push'])
  expect(stripWrappers(['builtin', '-x', 'echo']).words).toEqual(['-x', 'echo'])
  expect(stripLead(typed(['command', '-v', 'acli'])).words).toEqual(['-v', 'acli'])
})

test('stripLead drops time and its options in any order with the reserved words', () => {
  const cmd = ['git', '-C', '/tmp/r', 'push']
  expect(stripLead(typed(['time', '-p', ...cmd])).words).toEqual(cmd)
  expect(stripLead(typed(['time', '-p', '!', ...cmd])).words).toEqual(cmd)
  expect(stripLead(typed(['!', 'time', '-p', ...cmd])).words).toEqual(cmd)
  expect(stripLead(typed(['if', 'time', '--', '!', ...cmd])).words).toEqual(cmd)
  expect(stripLead(splitShell('time -p git push')[0]!).words).toEqual(['git', 'push'])
})

test('stripLead adds up the env and the nohup flag of every round', () => {
  const got = stripLead(typed(['A=1', 'time', '!', 'B=2', 'A=3', 'nohup', 'sleep', '9']))
  expect(got).toEqual({ words: ['sleep', '9'], env: { A: '3', B: '2' }, nohup: true })
})

test('stripLead leaves a command with nothing in front as it is, and an assignment line empty', () => {
  expect(stripLead(typed(['git', 'status']))).toEqual({ words: ['git', 'status'], env: {}, nohup: false })
  expect(stripLead(typed(['L=/x']))).toEqual({ words: [], env: { L: '/x' }, nohup: false })
  expect(stripLead(typed(['time', 'done']))).toEqual({ words: [], env: {}, nohup: false })
  expect(stripLead(typed([]))).toEqual({ words: [], env: {}, nohup: false })
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

// The same holds with a job that ends with `&` inside: the part holds a subshell, which is the shell that read the `&`, so it
// needs no wrapper either. Only a job in a group in the part (`{ a & } | b`) does.
test('splitShell adds no scope level for a pipeline part that holds only a subshell with a job in it', () => {
  const n = 12
  const segs = splitShell('( cat | '.repeat(n) + '( a & )' + ' )'.repeat(n))
  const depth = Math.max(...segs.map(s => s.scope.split('.').length - 1))
  expect(depth).toBeLessThanOrEqual(n + 2)
})

test('splitShell takes a stray ) } or done as it comes, with no scope or compound open', () => {
  expect(Object.keys(at(') a } | b ) c; done; d'))).toEqual(['a', 'b', 'c', 'done', 'd'])
  expect(Object.values(at('a ) b; done'))).toEqual(['', '', ''])
})

// A `}` right before the closing backtick ends its group, as it does before `;` or `)` (issue #161). Else the group
// stays open, and the `}` that comes later closes the wrong place.
test('splitShell ends a group at a } right before a closing backtick', () => {
  const words = (cmd: string) => splitShell(cmd).flatMap(s => (s.words.length > 0 ? [s.words.join(' ')] : []))
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
  expect(stripLead(splitShell('nohup printf x \\> out.txt &')[0]!).words).toEqual(['printf', 'x', '>', 'out.txt'])
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

// `}` and `)` are operators, so a `&` right behind them ends a segment with no word. The `&` still sets `$!`, so it makes a segment
// of its own, with no words and `bg`, in the shell that read it (issue #231). `done &`, `fi &` and `esac &` have a segment of their
// own (the closing word). `$!` names the shell that runs the list. Two forms are the exception, and `$!` names a command in both: a
// subshell whose last command is an external simple command (`( a ) &`, `( true; a ) &`), which bash runs in place, and a command
// that ends in a substitution (`sleep $(a) &`), which is a process. The parser makes no row for either (issue #231, owner decision
// 2026-10-26). A process substitution sets `$!` too, where it closes (`cat <(a) b`, `exec 3< <(a)`): it makes the same segment.
test('splitShell makes a segment with no words of a & that ends a group, subshell, arithmetic command or substitution', () => {
  // `&` stands for the segment with no words.
  const shape = (cmd: string) => splitShell(cmd).map(s => (s.words.length === 0 ? '&' : s.words.join(' ')))
  expect(shape('{ a; } & b')).toEqual(['a', '&', 'b'])
  expect(shape('( a ) & b')).toEqual(['a', '&', 'b'])
  expect(shape('(( 1 )) & b')).toEqual(['1', '&', 'b'])
  // Nothing follows the `&`: the segment is there all the same.
  expect(shape('{ a; } &')).toEqual(['a', '&'])
  // A redirection of the group does not hide the `&`: it has no word of its own.
  expect(shape('{ a; } > f & b')).toEqual(['a', '&', 'b'])
  expect(shape('{ a; } 2>&1 & b')).toEqual(['a', '&', 'b'])
  expect(shape('( a ) < f & b')).toEqual(['a', '&', 'b'])
  // A substitution that cuts a command ends with `)` or a backtick too: the `&` runs the whole command in the background.
  expect(shape('x=$(a) & b')).toEqual(['x=', 'a', '&', 'b'])
  expect(shape('x=`a` & b')).toEqual(['x=', 'a', '&', 'b'])
  expect(shape('echo $(a) & b')).toEqual(['echo', 'a', '&', 'b'])
  // A process substitution closes with `)` and sets `$!` there. The `&` behind it sends the command to the background and sets `$!`
  // there too: the segment of the `&` takes the place of the one before it, the two being one for the shell that reads them.
  expect(shape('cat <(a) & b')).toEqual(['cat', 'a', '&', 'b'])
  // Each `&` makes its own segment, in the place where it stands.
  expect(shape('{ a; } & b; c')).toEqual(['a', '&', 'b', 'c'])
  expect(shape('{ a; } & { b; } & c')).toEqual(['a', '&', 'b', '&', 'c'])
  expect(shape('{ { a; } & b; } & c')).toEqual(['a', '&', 'b', '&', 'c'])
  expect(shape('{ a & } & b')).toEqual(['a', '&', 'b'])
  expect(shape('a | { b; } & c')).toEqual(['a', 'b', '&', 'c'])
  expect(shape('{ a; } &\nb')).toEqual(['a', '&', 'b'])
  // The segment has no word, no mark and no redirection, and `bg`. It runs in the shell of the group, and its `&` was read outside.
  const [a, mark, b] = splitShell('{ a; } & b')
  expect(mark).toMatchObject({ words: [], marked: [], whole: [], redir: [], bg: true, readScope: '' })
  expect(mark!.scope).toBe(a!.scope)
  expect(b!.bg).toBe(false)
  // It is no command, so it makes no wrapper by itself: a subshell or a group of subshells that it ends keeps its own scopes.
  expect(splitShell('( a ) &').map(s => s.scope)).toEqual(['.1', ''])
  expect(splitShell('( a ) | ( b ) &').map(s => s.scope)).toEqual(['.1', '.2', ''])
  // No segment: a `&` behind a word, behind a loop, an `if` or a `case` (their closing word is a segment), a close with another
  // operator, a close with no `&`, a stray `&` with nothing before it, and a substitution with no `&`.
  for (const cmd of [
    'a & b',
    'a &',
    '{ a; }; b',
    '{ a; } && b',
    '( a ) || b',
    '{ a; } | b',
    '( a ) 2>&1; b',
    'for i in 1; do a; done & b',
    'if a; then b; fi & c',
    'case x in x) a;; esac & b',
    'case x in x) a & ;; esac; b',
    'a $(b) c & d',
    'a; & b',
    'a $(b) c',
    'x=$(a); b',
  ])
    expect({ cmd, marks: shape(cmd).filter(w => w === '&') }).toEqual({ cmd, marks: [] })
  // A process substitution makes the segment where it closes, with `&` or not.
  expect(shape('cat <(a) b')).toEqual(['cat', 'a', '&', 'b'])
  expect(shape('diff <(a) <(b)')).toEqual(['diff', 'a', '&', 'b', '&'])
  expect(shape('cat > >(a)')).toEqual(['cat', 'a', '&'])
  // The one inside a subshell, a substitution or a process substitution is not made: its shell ends there, and none reads it.
  expect(shape('cat <(cat <(a))')).toEqual(['cat', 'cat', 'a', '&'])
  expect(shape('x=$(cat <(a))')).toEqual(['x=', 'cat', 'a'])
  expect(shape('( { a; } & )')).toEqual(['a'])
  expect(shape('( { a; } & ) | b')).toEqual(['a', 'b'])
  expect(shape('( a; { b; } & ); c')).toEqual(['a', 'b', 'c'])
  // A substitution with nothing in it drops none of the segments of the shell around it.
  expect(shape('{ a; } & $()')).toEqual(['a', '&'])
  expect(shape('{ a; } & x=$()')).toEqual(['a', '&', 'x='])
  // A nest of them keeps one, the outer.
  expect(shape('{ { { a; } & } & } &')).toEqual(['a', '&'])
  expect(shape('( ( ( a ) & ) & ) &')).toEqual(['a', '&'])
  // The segment adds to `bg`: it takes none away, so `done &` still backgrounds its loop.
  expect(shape('for i in 1; do a; done & b')).toEqual(['for i in 1', 'do a', 'done', 'b'])
  expect(splitShell('for i in 1; do a; done & b').map(s => s.bg)).toEqual([false, false, true, false])
})

// A segment with `&` runs in a child scope of the shell that read the `&`, and `readScope` names that shell: the `&` sets the
// `$!` of it (issue #231). A group is the shell of its parent, so a pipe or a `&` behind it makes it a subshell of its own, and
// the job in it still reads its `&` there (`{ a & } | b`, `b | { a & }`, `{ a & } &`): bash 5.3.20 leaves the `$!` of the outer
// shell alone, and so must a reader of the scopes. A subshell, a substitution and backticks hold the job in a scope of their
// own already. The `&` that ends a list is read by the shell around the list, also when the job is the last part of a pipeline
// in a list that runs in the background (`x && y | a &`).
test('splitShell gives a job with & the shell that read the &, also for a group in a pipeline part or a background list', () => {
  const reader = (cmd: string, name: string): string => {
    const hit = splitShell(cmd).find(s => s.words.join(' ') === name)
    expect(hit).toBeDefined()
    expect(hit!.bg).toBe(true)
    return hit!.readScope
  }
  // The shell of the command reads the `&`: a job after `&&`, in a group, in an `if`, in a loop, and the last part of a pipeline.
  for (const [cmd, name] of [
    ['a &', 'a'],
    ['x && a &', 'a'],
    ['x; a & y', 'a'],
    ['{ a & }', 'a'],
    ['{ x; { a & }; }', 'a'],
    ['if x; then a & fi', 'then a'],
    ['for i in 1; do a & done', 'do a'],
    ['x | a &', 'a'],
    // The list runs in the background, and its last part is a part of a pipeline: the `&` is still read at the top.
    ['x && y | a &', 'a'],
    ['x && y | z | a &', 'a'],
    ['x | y | a &', 'a'],
  ] as const)
    expect({ cmd, reader: reader(cmd, name) }).toEqual({ cmd, reader: '' })
  // A subshell of its own reads it: a subshell, a substitution, backticks, and a group that a pipe or a `&` sends to one.
  for (const [cmd, name] of [
    ['( a & )', 'a'],
    ['( ( a & ) )', 'a'],
    ['x=$(a &)', 'a'],
    ['x=`a &`', 'a'],
    ['( a & ) | x', 'a'],
    ['{ a & } | x', 'a'],
    ['x | { a & }', 'a'],
    ['x | { a & } | y', 'a'],
    ['{ x; a & } | y', 'a'],
    ['{ a & } &', 'a'],
    ['{ { a & } & } | x', 'a'],
    ['x && { a & } | y', 'a'],
  ] as const)
    expect({ cmd, reader: reader(cmd, name) }).not.toEqual({ cmd, reader: '' })
  // The reader is a scope above the job, on its way to the top: the job runs in a child of it.
  for (const cmd of ['a &', '{ a & } | x', 'x | { a & }', 'x && y | a &', '{ a & } &', '( a & )', 'x=$(a &)']) {
    const job = splitShell(cmd).find(s => s.bg)
    expect(job).toBeDefined()
    expect({ cmd, below: job!.scope.startsWith(`${job!.readScope}.`) }).toEqual({ cmd, below: true })
  }
  // Each part of a pipeline is a shell, so two jobs in two parts have two readers, and a job in a group in a part reads it with
  // the commands of that part.
  expect(reader('{ a & } | { b & }', 'a')).not.toBe(reader('{ a & } | { b & }', 'b'))
  const part = splitShell('{ x; a & } | y')
  expect(part[1]!.readScope).toBe(part[0]!.scope)
  // A segment with no `&` reads in the scope it runs in, also after a move.
  for (const cmd of ['a | b', '{ a; } | b', 'x && a | b &', '( a ) &', 'x=$(a) | b', '{ a & x; } | b'])
    for (const s of splitShell(cmd).filter(s => !s.bg))
      expect({ cmd, seg: s.words, reads: s.readScope }).toEqual({ cmd, seg: s.words, reads: s.scope })
})

// `scopedCopy` holds state per shell, as `$!` needs it: a child copies the state of its nearest parent when it first appears, and
// its writes stay in it. The top level has the state that was passed in.
test('scopedCopy gives a scope a copy of its nearest parent when it first appears and keeps its writes in the scope', () => {
  const root = { n: 0 }
  const of = scopedCopy(root)
  expect(of('')).toBe(root)
  root.n = 1
  // No state at `.1` yet: the copy is the state of the top level.
  const child = of('.1.2')
  expect(child).toEqual({ n: 1 })
  expect(child).not.toBe(root)
  expect(of('.1.2')).toBe(child)
  child.n = 2
  expect(root.n).toBe(1)
  // The parent moves on: a child that opened before keeps what it copied, and a scope that opens now copies the new state.
  root.n = 3
  expect(of('.1.2').n).toBe(2)
  const middle = of('.1')
  expect(middle.n).toBe(3)
  middle.n = 4
  expect(of('.1.2').n).toBe(2)
  expect(of('.1.5').n).toBe(4)
  expect(root.n).toBe(3)
  expect(of('.9').n).toBe(3)
})

// A scope that holds no state is only on the way to a parent that has one (the wrapper of a subshell has no segment of its own).
// A wrapper that gets a state of its own later copies the nearest parent that has one at that time, and a scope under such a
// wrapper then copies the wrapper.
test('scopedCopy goes through scopes that hold no state, and a scope that gets one later copies the nearest parent', () => {
  const root = { n: 1 }
  const of = scopedCopy(root)
  expect(of('.1.2.3.4.5')).toEqual({ n: 1 })
  root.n = 2
  // `.1`, `.1.2`, `.1.2.3` and `.1.2.3.4` were passed with no state. One of them gets its own now: a copy of the root as it is.
  expect(of('.1.2.3').n).toBe(2)
  of('.1.2.3').n = 5
  // A scope under it copies it. A scope under a passed wrapper that holds none copies the root, and the leaf keeps its copy.
  expect(of('.1.2.3.9').n).toBe(5)
  expect(of('.1.2.7').n).toBe(2)
  expect(of('.1.2.3.4.5').n).toBe(1)
  expect(root.n).toBe(2)
  // The top level, and a scope right under it.
  expect(of('')).toBe(root)
  expect(of('.4').n).toBe(2)
})

// A leaf under a deep nest used to cost a walk of the whole nest, with a slice and a hash of the scope name at each step: O(d^2) for
// one leaf, and O(n d^2) for n leaves under the same nest. The walk goes by links now (`parseBashProcesses` has the same shapes).
const SCOPE_CHAINS: Record<string, (k: number) => string[]> = {
  'one leaf at the bottom of a deep chain': k => [Array.from({ length: 4_000 * k }, (_, i) => `.${i + 1}`).join('')],
  'many leaves under a chain': k => {
    const chain = Array.from({ length: 250 }, (_, i) => `.${i + 1}`).join('')
    return Array.from({ length: 3_000 * k }, (_, i) => `${chain}.${i + 251}`)
  },
}
for (const [family, make] of Object.entries(SCOPE_CHAINS)) {
  test(`scopedCopy stays linear on ${family}`, async () => {
    await expectLinear({
      label: family,
      make,
      run: scopes => {
        const of = scopedCopy({ n: 0 })
        for (const scope of scopes) of(scope)
      },
    })
  })
}

// The segment of a `&` that ends a group sets `$!` in the shell that reads it: `readScope` names that shell. A substitution, a
// backtick pair, a subshell and a part of a pipeline run in a shell of their own, so a `&` in them leaves the `$!` of the parent
// alone (bash 5.3.20: after `sleep 5 &`, `x=$({ :; } &)`, `( { :; } & )`, `{ { :; } & } | cat` and `cat | { { :; } & }` all leave
// `$!` on `sleep 5`). The segment stands where the `&` stands, so no command after it can change who reads it. The earlier build
// put a flag on the next segment: a pipe sent that segment to a shell of its own, and the flag followed it (`{ :; } & echo hi |
// cat; echo $!` prints the pid of the group, and the parent kept the job before it; the audit of 74ec61d). A process substitution
// sets `$!` in the shell that runs its command, so its segment is read there too. A segment behind the last command of a part or a
// background list sets the `$!` of a shell that ends there: it is dead, and no reader looks at it.
test('splitShell gives the segment of a & behind a group, and of a process substitution, the shell that read it', () => {
  // For each segment with no words: `top` when the top shell reads it, `sub` when a shell of its own does.
  const kinds = (cmd: string) =>
    splitShell(cmd)
      .filter(s => s.words.length === 0)
      .map(s => (s.readScope === '' ? 'top' : 'sub'))
  // The shell of the command reads it: in a group, behind `&&`, in an `if` or a loop, and for the `&` that ends a list that runs in
  // the background (also when the list ends with a pipeline).
  for (const cmd of [
    '{ a; } &',
    'x && { a; } &',
    '{ { a; } & }',
    '{ x; ( a ) & }',
    'if x; then ( a ) & fi',
    'for i in 1; do ( a ) & done',
    'x | { a; } &',
    'x && y | ( a ) &',
    'x=$(a) &',
    'cat <(a)',
    '{ cat <(a); }',
    'if x; then cat <(a); fi',
    'for i in 1; do cat <(a); done',
    'exec 3< <(a)',
  ])
    expect({ cmd, kinds: kinds(cmd) }).toEqual({ cmd, kinds: ['top'] })
  // A shell of its own reads it: a group in a part of a pipeline (the part is a subshell, which the group joins).
  for (const cmd of [
    '{ { a; } & b; } | x',
    'x | { { a; } & b; }',
    '{ { a; } & } | x',
    'x | { { a; } & } | y',
    '{ x; { a; } & } | y',
    'cat <(a) | x',
    'x | cat <(a)',
    '{ cat <(a); } | x',
  ])
    expect({ cmd, kinds: kinds(cmd) }).toEqual({ cmd, kinds: ['sub'] })
  // No segment: a subshell, a substitution and a backtick pair end the shell that the `&` or the substitution set `$!` in, and no
  // command runs in it after that.
  for (const cmd of [
    '( { a; } & )',
    '( ( a ) & )',
    'x=$({ a; } &)',
    'x=`{ a; } &`',
    'x=$(cat <(a))',
    'x=`cat <(a)`',
    '( cat <(a) )',
    '( { a; } & ) | x',
    'x | ( { a; } & )',
  ])
    expect({ cmd, kinds: kinds(cmd) }).toEqual({ cmd, kinds: [] })
  // A `&` that sends the group to the background: the `&` behind the group is read outside, and a nest of them keeps one.
  expect(kinds('{ { a; } & } &')).toEqual(['top'])
  expect(kinds('( { a; } & ) &')).toEqual(['top'])
  expect(kinds('cat <(a) &')).toEqual(['top'])
  expect(kinds('{ { { a; } & } & } &')).toEqual(['top'])
  // A command behind the inner `&` in the same group reads the `$!` that it set (`{ { :; } & echo $!; } &` prints the pid of the
  // inner group), so both stay, and the inner one is read by the shell of the outer group.
  expect(kinds('{ { a; } & b; } &')).toEqual(['sub', 'top'])
  // Each part of a pipeline is a shell, so two segments in two parts have two readers.
  expect(kinds('{ a; } & { b; } | { { c; } & }')).toEqual(['top', 'sub'])
  // A segment with words keeps its rule: it reads in the scope it runs in, or, with `&`, in the shell that read the `&`. A `&`
  // that has no command and no close before it (`a && &`, bash calls it an error) ends no segment, so `a` is no job of it.
  for (const cmd of ['{ a; } & b | c', 'x=$(a) & b', 'cat <(a) & b', 'a && &', 'a | &'])
    for (const s of splitShell(cmd).filter(s => s.words.length > 0 && !s.bg))
      expect({ cmd, seg: s.words, reads: s.readScope }).toEqual({ cmd, seg: s.words, reads: s.scope })
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
  // Glued to the word before it, the here-string ends that word, as in bash (issue #231). The lines after it are commands.
  expect(words('cat<<<hi\ncd /x\ngit -C . status')).toEqual(['cat', ...rest])
})

// A heredoc has the same first characters as a here-string. Each form that the splitter knows still hides its body, and the
// command after the tag line is read. An escaped `<` in front is a word, so the `<<` after it is a heredoc. An escaped tag
// (`<<\EOF`) and a file descriptor in front (`3<<EOF`) have their own test below (issue #194).
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

// A heredoc with an escaped, quoted or split tag is a heredoc (issue #194). The tag is the next word with its quotes and
// backslashes removed, so `<<\EOF` is the same as `<<'EOF'`: bash skips the body, and the word `EOF` is no command.
test('splitShell skips the body of a heredoc with an escaped or mixed-quote tag', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const body = 'cd /y\nEOF\ngit -C . status'
  const after = ['cat', 'git -C . status']
  expect(words(`cat <<\\EOF\n${body}`)).toEqual(after)
  expect(words(`cat << \\EOF\n${body}`)).toEqual(after)
  expect(words(`cat <<E\\OF\n${body}`)).toEqual(after)
  expect(words(`cat <<E"O"F\n${body}`)).toEqual(after)
  expect(words(`cat <<"E"'O'F\n${body}`)).toEqual(after)
  expect(words('cat <<-\\EOF\n\tcd /y\n\tEOF\ngit -C . status')).toEqual(after)
  // A tag with a blank or a slash in it.
  expect(words("cat <<'E O F'\ncd /y\nE O F\ngit -C . status")).toEqual(after)
  expect(words('cat <<a/b\ncd /y\na/b\ngit -C . status')).toEqual(after)
  // A command, a redirection or a pipe on the line of the heredoc.
  expect(words(`cat <<\\EOF; echo a\n${body}`)).toEqual(['cat', 'echo a', 'git -C . status'])
  expect(words(`cat <<\\EOF > f\n${body}`)).toEqual(after)
  expect(words(`cat <<\\EOF | wc\n${body}`)).toEqual(['cat', 'wc', 'git -C . status'])
  // The escaped tag is still the tag: a line that only starts like it does not end the body.
  expect(words('cat <<\\EOF\ncd /y\nEOFX\ncd /z\nEOF\ngit -C . status')).toEqual(after)
  // Two heredocs, one of them escaped. An empty tag ends at an empty line.
  expect(words('cat <<\\A <<B\ncd /y\nA\ncd /z\nB\ngit -C . status')).toEqual(after)
  expect(words("cat <<''\ncd /y\n\ngit -C . status")).toEqual(after)
})

// The tag follows the quoting rules of bash. In double quotes a backslash escapes only `$`, a backtick, a quote, a backslash
// and a newline, so `"E\xF"` is the tag `E\xF`. A backslash and a newline in the word vanish. A quote that never closes
// gives no tag: bash reports an error for that, and the splitter reads the text as before.
test('splitShell reads the tag of a heredoc by the quoting rules of bash', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const after = ['cat', 'cd /x']
  expect(words('cat <<"E\\"F"\ncd /y\nE"F\ncd /x')).toEqual(after)
  expect(words('cat <<"E\\$F"\ncd /y\nE$F\ncd /x')).toEqual(after)
  expect(words('cat <<"E\\xF"\ncd /y\nE\\xF\ncd /x')).toEqual(after)
  expect(words('cat <<"E\\\\F"\ncd /y\nE\\F\ncd /x')).toEqual(after)
  expect(words('cat <<E\\\nOF\ncd /y\nEOF\ncd /x')).toEqual(after)
  // `$'EOF'` and `$"EOF"` quote the tag as `'EOF'` and `"EOF"` do: bash drops the `$`. A `$` that no quote follows is part of
  // the tag (`<<$EOF` has the tag `$EOF`). A backslash escape inside `$'...'` (`\n`, `\x41`) stays unread: a limit of the KB.
  expect(words("cat <<$'EOF'\ncd /y\nEOF\ncd /x")).toEqual(after)
  expect(words('cat <<$"EOF"\ncd /y\nEOF\ncd /x')).toEqual(after)
  expect(words("cat <<-$'EOF'\n\tcd /y\n\tEOF\ncd /x")).toEqual(after)
  expect(words("cat <<E$'O'F\ncd /y\nEOF\ncd /x")).toEqual(after)
  expect(words("cat << $'E O F'\ncd /y\nE O F\ncd /x")).toEqual(after)
  expect(words('cat <<$EOF\ncd /y\n$EOF\ncd /x')).toEqual(after)
  // An unclosed quote, and a `<<` with no word after it, start no heredoc.
  expect(words("cat <<'EOF\ncd /x")).toEqual(['cat EOF\ncd /x'])
  expect(words('cat <<"EOF\ncd /x')).toEqual(['cat EOF\ncd /x'])
  expect(words('cat <<\ncd /x')).toEqual(['cat', 'cd /x'])
  expect(words('cat <<')).toEqual(['cat'])
  expect(words('cat <<\\')).toEqual(['cat'])
})

// A command or arithmetic substitution in the tag is part of the tag, as typed: bash does not expand the delimiter, and its
// closing line is that same text (Codex review of the PR). The `(` and the `)` of the substitution do not end the tag,
// and neither does a blank, a quote or a `)` inside it. A substitution that never closes gives no tag.
test('splitShell reads a command substitution in a heredoc tag as a part of the tag', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const after = ['cat', 'cd /x']
  expect(words('cat <<$(echo EOF)\ncd /y\n$(echo EOF)\ncd /x')).toEqual(after)
  expect(words('cat <<$((1+1))\ncd /y\n$((1+1))\ncd /x')).toEqual(after)
  expect(words("cat <<$(echo 'a b')\ncd /y\n$(echo 'a b')\ncd /x")).toEqual(after)
  expect(words('cat <<$(echo "a b")\ncd /y\n$(echo "a b")\ncd /x')).toEqual(after)
  expect(words('cat <<$(echo ")")\ncd /y\n$(echo ")")\ncd /x')).toEqual(after)
  expect(words('cat <<$(echo \\))\ncd /y\n$(echo \\))\ncd /x')).toEqual(after)
  expect(words('cat <<$(echo $(echo EOF))\ncd /y\n$(echo $(echo EOF))\ncd /x')).toEqual(after)
  expect(words('cat <<a$(echo x)b\ncd /y\na$(echo x)b\ncd /x')).toEqual(after)
  expect(words('cat <<-$(echo EOF)\n\tcd /y\n\t$(echo EOF)\ncd /x')).toEqual(after)
  expect(words('cat << $(echo EOF)\ncd /y\n$(echo EOF)\ncd /x')).toEqual(after)
  // The text after the tag on the same line is read as usual, and a line with only the command inside ends nothing.
  expect(words('cat <<$(echo EOF); echo a\ncd /y\n$(echo EOF)\ncd /x')).toEqual(['cat', 'echo a', 'cd /x'])
  expect(words('cat <<$(echo EOF)\ncd /y\nEOF\ncd /z\n$(echo EOF)\ncd /x')).toEqual(after)
  // A substitution that never closes starts no heredoc: the text is read as before. It costs a bounded scan.
  expect(words('cat <<$(echo EOF\ncd /x')).toEqual(['cat', 'echo EOF', 'cd /x'])
})

// A file descriptor in front of `<<` belongs to the redirection (issue #194): `cat 3<<EOF` runs `cat`. Only digits or a
// `{name}` that are typed, glued to the `<<` and a word of their own count. `a3<<EOF`, `3 <<EOF` and `'3'<<EOF` keep the word.
test('splitShell drops the file descriptor in front of a heredoc', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const body = 'hi\nEOF\ngit -C . status'
  const after = ['cat', 'git -C . status']
  expect(words(`cat 3<<EOF\n${body}`)).toEqual(after)
  expect(words(`cat 3<< EOF\n${body}`)).toEqual(after)
  expect(words('cat 12<<-EOF\n\thi\n\tEOF\ngit -C . status')).toEqual(after)
  expect(words(`cat 3<<'EOF'\n${body}`)).toEqual(after)
  expect(words(`cat 3<<\\EOF\n${body}`)).toEqual(after)
  expect(words(`cat {fd}<<EOF\n${body}`)).toEqual(after)
  expect(words(`cat a 3<<EOF b\n${body}`)).toEqual(['cat a b', 'git -C . status'])
  expect(words(`cat 3<<EOF; echo a\n${body}`)).toEqual(['cat', 'echo a', 'git -C . status'])
  // The control: a word that only ends in digits, a spaced `3`, a quoted or escaped `3`, and a here-string.
  expect(words(`cat a3<<EOF\n${body}`)).toEqual(['cat a3', 'git -C . status'])
  expect(words(`cat 3 <<EOF\n${body}`)).toEqual(['cat 3', 'git -C . status'])
  expect(words(`cat '3'<<EOF\n${body}`)).toEqual(['cat 3', 'git -C . status'])
  expect(words(`cat \\3<<EOF\n${body}`)).toEqual(['cat 3', 'git -C . status'])
  expect(words(`cat x{fd}<<EOF\n${body}`)).toEqual(['cat x{fd}', 'git -C . status'])
  expect(words('cat 3<<<hi\ngit -C . status')).toEqual(after)
})

// `{name}` in front of `<`, `>` or `<>` is a variable file descriptor (issue #194): bash opens the target and stores the
// number in `$name`. It is a redirection, so the `{name}` word and its target are no words of the command.
test('splitShell drops a variable file descriptor redirection with its target', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  expect(words('cd {fd}>f /x; git -C . status')).toEqual(['cd /x', 'git -C . status'])
  expect(words('exec {fd}<> lock; git -C /y status')).toEqual(['exec', 'git -C /y status'])
  // The target glued or spaced, the other operators, and the words around it.
  expect(words('cmd a {fd}> f b')).toEqual(['cmd a b'])
  expect(words('cmd a {fd}>>f b')).toEqual(['cmd a b'])
  expect(words('cmd a {fd}<f b')).toEqual(['cmd a b'])
  expect(words('cmd a {fd}< f b')).toEqual(['cmd a b'])
  expect(words('cmd a {fd}<>f b')).toEqual(['cmd a b'])
  expect(words('cmd a {fd}>|f b')).toEqual(['cmd a b'])
  expect(words('cmd a {fd}<<<hi b')).toEqual(['cmd a b'])
  expect(words('cmd a {fd}>&2 b')).toEqual(['cmd a b'])
  expect(words('cmd a {fd}<&- b')).toEqual(['cmd a b'])
  expect(words("cmd a {fd}> 'f g' b")).toEqual(['cmd a b'])
  expect(words('cmd {_a1}>f {b2}<> g c')).toEqual(['cmd c'])
  // Operators after the target work as usual.
  expect(words('cmd {fd}>f && a\nb | c')).toEqual(['cmd', 'a', 'b', 'c'])
  // Only a typed `{name}` right in front of the operator counts. A spaced one, a bad name and a quoted one are words.
  expect(words('echo {fd} >f')).toEqual(['echo {fd}'])
  expect(words('echo {fd}')).toEqual(['echo {fd}'])
  expect(words('echo {1x} c')).toEqual(['echo {1x} c'])
  expect(words('echo "{fd}>f" c')).toEqual(['echo {fd}>f c'])
  expect(words("echo '{fd}>f' c")).toEqual(['echo {fd}>f c'])
  // A name that is no identifier, or a name glued to a word, is no variable file descriptor. Bash splits the word at the `>`
  // there (the word `{1x}` or `x{fd}` stays and `>f` is a redirection), and so does the splitter since issue #231.
  expect(words('echo {1x}>f c')).toEqual(['echo {1x} c'])
  expect(words('echo x{fd}>f c')).toEqual(['echo x{fd} c'])
})

// Only a reserved word that was typed whole is one (issue #194): `'done' git -C /x status` runs a command named `done`.
// The splitter keeps the word, and `stripLead` reads `Segment.whole` as `compoundLead` and `closesAt` read `Typed.whole`.
test('stripLead keeps a quoted or escaped reserved word, which is a command', () => {
  const lead = (cmd: string) => splitShell(cmd).map(s => stripLead(s).words.join(' '))
  expect(lead("'done' git -C /x status")).toEqual(['done git -C /x status'])
  for (const q of ["'done'", '"done"', '\\done', "d'on'e", 'd\\one', "done''", 'done""', "''done"])
    expect(lead(`${q} git -C /x status`)).toEqual(['done git -C /x status'])
  expect(lead("'fi' git -C /x status")).toEqual(['fi git -C /x status'])
  expect(lead("'esac' git -C /x status")).toEqual(['esac git -C /x status'])
  expect(lead("'!' git -C /x status")).toEqual(['! git -C /x status'])
  expect(lead("'if' git -C /x status")).toEqual(['if git -C /x status'])
  // A quoted word behind a typed one, and behind a wrapper: the scan stops at the first command word.
  expect(lead("for i in 1; do 'done' y; done")).toEqual(['for i in 1', 'done y', ''])
  expect(lead("if ! 'done' y; then z; fi")).toEqual(['done y', 'z', ''])
  expect(lead("time ! 'fi' y")).toEqual(['fi y'])
  // The typed words still go: the control.
  expect(lead('for i in 1; do git -C /x status; done')).toEqual(['for i in 1', 'git -C /x status', ''])
  expect(lead('if ! git -C /x status; then :; fi')).toEqual(['git -C /x status', ':', ''])
})

// `stripReserved` keeps the typed flags optional: no flags means every word counts as typed. `stripLead` has no such
// fallback. It takes the words with their flags (a `Segment` fits), so a reader that leaves `whole` or `redir` out does not
// compile and cannot bring issue #194 or issue #227 back without a sign.
test('stripReserved reads the optional typed flags of the words, and stripLead the flags of its segment', () => {
  expect(stripReserved(['done', 'git'], [false, true])).toEqual(['done', 'git'])
  expect(stripReserved(['do', 'done', 'git'], [true, false, true])).toEqual(['done', 'git'])
  expect(stripReserved(['do', 'done', 'git'], [true, true, true])).toEqual(['git'])
  expect(
    stripLead({
      words: ['time', '!', 'fi', 'git'],
      whole: [true, true, false, true],
      redir: [false, false, false, false],
    }).words,
  ).toEqual(['fi', 'git'])
  expect(
    stripLead({
      words: ['!', 'time', 'sudo', 'if', 'git'],
      whole: [true, true, true, false, true],
      redir: [false, false, false, false, false],
    }).words,
  ).toEqual(['if', 'git'])
  // A word behind a redirection is no option of `time`, whatever the reserved words in front of it.
  expect(
    stripLead({
      words: ['!', 'time', '-p', 'git'],
      whole: [true, true, true, true],
      redir: [false, false, true, false],
    }).words,
  ).toEqual(['-p', 'git'])
  // Every word typed: the reserved words go.
  expect(stripReserved(['done', 'git'])).toEqual(['git'])
  expect(stripLead(typed(['time', '!', 'fi', 'git'])).words).toEqual(['git'])
})

// A `<<` inside `$(( ))` or `(( ))` is a shift, not a heredoc (issue #194). Bash evaluates it, and the lines after it run.
test('splitShell reads << inside an arithmetic expression as a shift, so the next lines are commands', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const rest = ['cd /x', 'git -C . status']
  expect(words('x=$((1<<2))\ncd /x\ngit -C . status')).toEqual(['x=', ...rest])
  expect(words('x=$(( 1 << 2 ))\ncd /x\ngit -C . status')).toEqual(['x=', '1', ...rest])
  expect(words('(( x << 2 ))\ncd /x\ngit -C . status')).toEqual(['x', ...rest])
  expect(words('(( x<<2 ))\ncd /x\ngit -C . status')).toEqual(['x<<2', ...rest])
  expect(words('((x<<=2))\ncd /x\ngit -C . status')).toEqual(['x<<=2', ...rest])
  expect(words('(( y = 1 << 3 ))\ncd /x\ngit -C . status')).toEqual(['y = 1', ...rest])
  // After a here-string, in a command, in a loop header, a condition and a grouping parenthesis.
  expect(words('cat <<< $((1<<2))\ncd /x\ngit -C . status')).toEqual(['cat', ...rest])
  expect(words('cat <<<$((1<<2))\ncd /x\ngit -C . status')).toEqual(['cat', ...rest])
  expect(words('echo $((1<<2))\ncd /x\ngit -C . status')).toEqual(['echo', ...rest])
  expect(words('for ((i=1<<2; i<5; i++)); do :; done\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
  expect(words('if (( x << 2 )); then :; fi\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
  expect(words('while (( x << 2 )); do :; done\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
  expect(words('x=$(( (1<<2) + (3<<1) ))\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
  expect(words('x=$((1<<2)) y=$((3<<4))\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
  expect(words('x=$(( $((1<<2)) << 1 ))\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
  // In a case arm and in a pipeline, and after a here-string on the same line.
  expect(words('case x in x) (( 1<<2 )) ;; esac\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
  expect(words('echo $((1<<2)) | wc\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
  expect(words('cat <<< hi; (( 1<<2 ))\ncd /x\ngit -C . status').slice(-2)).toEqual(rest)
})

// The shift guard reaches only the arithmetic text. A heredoc in a command substitution inside it is a heredoc, and so is
// one in `$((cd /x); y)`, which bash reads as a subshell in `$( )` when no `))` closes it.
test('splitShell still reads a heredoc next to arithmetic, in a substitution and after one', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const inside = words('x=$(( $(cat <<EOF\ncd /y\nEOF\n) + 1 ))\ncd /x')
  expect(inside).not.toContain('cd /y')
  expect(inside).toContain('cd /x')
  const sub = words('x=$((cat <<EOF\ncd /y\nEOF\n); cd /z)\ncd /x')
  expect(sub).not.toContain('cd /y')
  expect(sub.slice(-2)).toEqual(['cd /z', 'cd /x'])
  // A heredoc after the arithmetic still hides its body, also on the line of the arithmetic.
  expect(words('x=$((1<<2))\ncat <<EOF\ncd /y\nEOF\ncd /x')).toEqual(['x=', 'cat', 'cd /x'])
  expect(words('cat <<EOF; x=$((1<<2))\ncd /y\nEOF\ncd /x')).toEqual(['cat', 'x=', 'cd /x'])
  // A `<<` after the arithmetic has closed is a heredoc again.
  expect(words('echo $((1+2)) <<EOF\ncd /y\nEOF\ncd /x')).toEqual(['echo', '1+2', 'cd /x'])
  expect(words('(( 1 )) && cat <<EOF\ncd /y\nEOF\ncd /x')).toEqual(['1', 'cat', 'cd /x'])
  // A process substitution that starts with `((` is no arithmetic: `<((echo a))` is `<(` and a subshell.
  const proc = words('cat <((cat <<EOF\ncd /y\nEOF\n))\ncd /x')
  expect(proc).not.toContain('cd /y')
  expect(proc).toContain('cd /x')
})

// The scan for the end of the arithmetic text hides a `)` in quotes and after a backslash, as bash does. An expression with
// no `))` is none: its `<<` stays a heredoc, as before.
test('splitShell finds the end of arithmetic text past quoted parentheses, and none when it never ends', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  expect(words('(( x = ")" << 2 ))\ncd /x')).toContain('cd /x')
  expect(words("(( x = ')' << 2 ))\ncd /x")).toContain('cd /x')
  expect(words('(( x = \\) << 2 ))\ncd /x')).toContain('cd /x')
  expect(words('(( x = "a\\"(" << 2 ))\ncd /x')).toContain('cd /x')
  expect(words('(( x = ( 1 << 2 ) ))\ncd /x')).toContain('cd /x')
  // Never closed: the unclosed quote, the missing `))` and the single `)` give no arithmetic.
  expect(words('(( x << 2\ncd /x\n2\ngit -C . status')).not.toContain('cd /x')
  expect(words("(( x = ' << 2 ))\ncd /x")).not.toContain('cd /x')
  expect(words('(( x << 2 )\ncd /x\n2\ngit -C . status')).not.toContain('cd /x')
})

// The check for arithmetic text scans ahead from each `((` and `$((`. It stops after `MAX_ARITH` characters, so a run of
// unterminated or nested openers costs a bounded scan each and `splitShell` stays linear on text that a model wrote
// (issue #194). Without the cap each opener reads to the end of the text, and 4 times the input costs 16 times as much.
const SCAN_FAMILIES: Record<string, (k: number) => string> = {
  'unterminated ((': k => '(('.repeat(1_250 * k),
  'unterminated $((': k => '$(('.repeat(2_500 * k),
  'nested $((': k => '$(('.repeat(2_500 * k) + '1' + '))'.repeat(2_500 * k),
  // The tag of a heredoc that opens a substitution never closes: each `<<` then scans ahead, up to the cap.
  'unterminated <<$(': k => '<<$('.repeat(2_500 * k),
  'unterminated <<$( with a quote': k => "<<$(echo '".repeat(1_500 * k),
}
for (const [family, make] of Object.entries(SCAN_FAMILIES)) {
  test(`splitShell stays linear on ${family}`, async () => {
    await expectLinear({ label: family, make, run: text => splitShell(text) })
  })
}

// The cap is far above any real expression. Past it the text counts as no arithmetic, which is how it read before issue
// #194: the shift is a heredoc tag again, and the lines after it are lost. The scan covers 256 characters after the `((`.
test('splitShell reads arithmetic text up to the cap, and none past it', () => {
  const words = (cmd: string) => splitShell(cmd).map(s => s.words.join(' '))
  const sum = (n: number) => '1+'.repeat(n)
  expect(words(`x=$(( ${sum(100)}1<<2 ))\ncd /x`)).toContain('cd /x')
  expect(words(`x=$(( ${sum(200)}1<<2 ))\ncd /x`)).not.toContain('cd /x')
  // The edge: the `)` at the end of the scan still reads the character behind it, so only the scan is bounded. The text
  // between `((` and `))` is `n` ones and `<<2`: with 252 ones the first `)` is the last character that the scan reads.
  const at = (n: number) => words(`x=$((${'1'.repeat(n)}<<2))\ncd /x`).includes('cd /x')
  expect(at(252)).toBe(true)
  expect(at(253)).toBe(false)
})

// The scan for the end of a substitution in a heredoc tag has a cap too (`MAX_SUB`, 256 characters from the `(`). A tag with
// more is no tag: the `<<` starts no heredoc, and the lines after it are read as commands, as before.
test('splitShell reads a substitution in a heredoc tag up to the cap, and none past it', () => {
  const hides = (n: number) => {
    const tag = `$(${'x'.repeat(n)})`
    return !splitShell(`cat <<${tag}\ncd /y\n${tag}\ncd /x`).some(s => s.words.join(' ') === 'cd /y')
  }
  expect(hides(254)).toBe(true)
  expect(hides(255)).toBe(false)
})

// Where the standard output of a segment goes (issue #231). `>`: a typed redirection of fd 1, on the segment or on the group,
// subshell or loop around it. `|`: a `|` or `|&` follows the pipeline part that holds it, so its output feeds the next
// command. `$`: it runs inside `$(...)`, backticks or `<(...)`, so the shell takes its output. A segment with
// none of the three prints to the tool result. The readers that pair an output line with a command (`docker run -d` and its
// container id) read the marks.
// A segment with no words is no command (it says where `$!` was set), so it prints nothing and has no mark to read.
const outMarks = (cmd: string) =>
  splitShell(cmd)
    .filter(s => s.words.length > 0)
    .map(
      s =>
        `${s.words.join(' ')}${s.stdoutRedirected ? ' >' : ''}${s.stdoutPiped ? ' |' : ''}${s.substituted ? ' $' : ''}`,
    )

test('splitShell marks a typed redirection of the standard output', () => {
  for (const redir of [
    '> f',
    '>f',
    '>> f',
    '>>f',
    '>| f',
    '&> f',
    '&>f',
    '&>> f',
    '1> f',
    '1>f',
    '1>> f',
    '1>| f',
    '>&2',
    '1>&2',
    '> /dev/null 2>&1',
    '2>&1 > f',
    '2> e > f',
    '2> e >f',
    // A copy of another descriptor onto fd 1, a close, and a file that only looks like a descriptor move it. The target of a
    // spaced `>&` is no word of the command (`>& f` sends both outputs to the file `f`).
    '>& 2',
    '1>& 2',
    '>&-',
    '1>&-',
    '>&0',
    '>&10',
    '>&11',
    '>&1x',
    '>& f',
    // `&>&1` and `>>&1` are syntax errors in bash (5.3.20). They copy nothing, so the reader keeps them as a redirection.
    '&>&1',
    '>>&1',
    // A copy of fd 1 onto itself next to another redirection of fd 1: the other one moves it, in either order.
    '>&1 > f',
    '> f >&1',
    '>&1 2>&2 &> f',
  ])
    expect({ redir, marks: outMarks(`docker run -d x ${redir}`) }).toEqual({ redir, marks: ['docker run -d x >'] })
  // An empty quote right behind `>&` is the target (bash: ambiguous redirect), so the next word stays a word of the command.
  expect(outMarks("docker run -d x >&'' y")).toEqual(['docker run -d x y >'])
})

// A typed `>` or `<` ends the word before it, as in bash (issue #231): `nginx>f` is the word `nginx` and the redirection `>f`.
// A reader that looked at the start of each word saw no redirection there, so the run took the id of another command.
test('splitShell marks a redirection of the standard output glued to the last word', () => {
  for (const redir of ['>f', '>>f', '>|f', '&>f', '&>>f', '>&2'])
    expect({ redir, marks: outMarks(`docker run -d nginx${redir}`) }).toEqual({
      redir,
      marks: ['docker run -d nginx >'],
    })
  // The digit before the `>` is part of the word when the word has text before it: `nginx2>f` is the word `nginx2` and `>f`.
  expect(outMarks('docker run -d nginx2>f')).toEqual(['docker run -d nginx2 >'])
  expect(outMarks('docker run -d nginx 2>f')).toEqual(['docker run -d nginx'])
  // Bash has no `N&>` form: the number or the `{name}` in front of `&>` is a word of its own, as `echo a 12&>f` shows.
  expect(outMarks('docker run -d x 12&>f')).toEqual(['docker run -d x 12 >'])
  expect(outMarks('sleep 1&>>f')).toEqual(['sleep 1 >'])
  expect(outMarks('echo a {fd}&>f')).toEqual(['echo a {fd} >'])
  expect(outMarks('echo a {1x}&>f')).toEqual(['echo a {1x} >'])
  // A number in front of `>` or `>&` belongs to the redirection, and `&>` keeps its `&`.
  expect(outMarks('docker run -d x 2>&1')).toEqual(['docker run -d x'])
  expect(outMarks('docker run -d x 12>&1 &>f')).toEqual(['docker run -d x >'])
  expect(outMarks('docker run -d x &>f')).toEqual(['docker run -d x >'])
  expect(outMarks('docker run -d "nginx">f')).toEqual(['docker run -d nginx >'])
  expect(outMarks("docker run -d 'nginx'>>f")).toEqual(['docker run -d nginx >'])
  // A number that was quoted or escaped is a word, no file descriptor: only a typed one belongs to the redirection (`2>f`).
  expect(outMarks('docker run -d "2">f')).toEqual(['docker run -d 2 >'])
  expect(outMarks("docker run -d '1'>f")).toEqual(['docker run -d 1 >'])
  expect(outMarks('docker run -d \\2>f')).toEqual(['docker run -d 2 >'])
  // A `{` inside a word is no `${`: it opens no parameter expansion, so the `>` after it ends the word.
  expect(outMarks('docker run -d a{b>f')).toEqual(['docker run -d a{b >'])
  expect(outMarks('docker run -d $IMG>f')).toEqual(['docker run -d $IMG >'])
  expect(outMarks('docker run -d -e A=b>f nginx')).toEqual(['docker run -d -e A=b nginx >'])
  // The words after the redirection stay, and the next command is not marked.
  expect(outMarks('a b>f c; d e')).toEqual(['a b c >', 'd e'])
})

test('splitShell leaves the output alone for an input redirection or a here-string glued to the last word', () => {
  expect(outMarks('docker run -d nginx<f')).toEqual(['docker run -d nginx'])
  expect(outMarks('docker run -d nginx<<<x')).toEqual(['docker run -d nginx'])
  expect(outMarks('docker run -d nginx<>f')).toEqual(['docker run -d nginx'])
  // A quoted or escaped `>` glued to a word is text.
  expect(outMarks("docker run -d nginx'>'f")).toEqual(['docker run -d nginx>f'])
  expect(outMarks('docker run -d nginx\\>f')).toEqual(['docker run -d nginx>f'])
})

test('splitShell marks the group, subshell or compound that a glued redirection follows', () => {
  expect(outMarks('{ a; b; }>f')).toEqual(['a >', 'b >'])
  expect(outMarks('{ a; }>>f; c')).toEqual(['a >', 'c'])
  expect(outMarks('( a; b )>f')).toEqual(['a >', 'b >'])
  expect(outMarks('for i in 1; do a; done>f')).toEqual(['for i in 1 >', 'do a >', 'done >'])
  expect(outMarks('if a; then b; fi>f; c')).toEqual(['if a >', 'then b >', 'fi >', 'c'])
  expect(outMarks('while a; do b; done>|f')).toEqual(['while a >', 'do b >', 'done >'])
  expect(outMarks('case $x in y) a;; esac>f')).toEqual(['case $x in >', 'a >', 'esac >'])
  expect(outMarks('{ a; }&>f')).toEqual(['a >'])
  // A glued redirection of the input leaves the output alone. (`}2>f` is the word `}2`, not a close, as in bash.)
  expect(outMarks('{ a; }<f')).toEqual(['a'])
  expect(outMarks('for i in 1; do a; done<f')).toEqual(['for i in 1', 'do a', 'done'])
})

// A `>` in an open `${ }` is text (`${X:-a>b}`), so the word does not end there and the command is not redirected. A nested `${ }`
// keeps the outer one open until its own `}`. The word is closed again after the `}`, and then a `>` is a redirection.
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the texts are shell commands, and `${X}` is a parameter expansion
test('splitShell keeps a > inside an open parameter expansion as text', () => {
  for (const text of ['echo ${X:-a>b} c', 'echo ${X:-${Y}>b} c', 'echo ${X:-a<b} c']) {
    expect({ text, words: splitShell(text).map(s => s.words.join(' ')) }).toEqual({ text, words: [text] })
    expect({ text, marks: outMarks(text) }).toEqual({ text, marks: [text] })
  }
  expect(outMarks('echo ${X}>f c')).toEqual(['echo ${X} c >'])
  expect(outMarks('echo ${X:-a}>f c')).toEqual(['echo ${X:-a} c >'])
  // An open `${` ends with its word: it does not reach the next command.
  expect(outMarks('echo ${X; a>f')).toEqual(['echo ${X', 'a >'])
})
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of the shell texts

// `done<f` and `}<f` end the loop or the group, so the loop is closed and a `cd` in it does not reach the commands after it.
test('splitShell closes a loop at a glued input redirection', () => {
  const scopes = (cmd: string) => splitShell(cmd).map(s => `${s.words.join(' ')}@${s.scope}`)
  expect(scopes('while read l; do cd /x; done<f | cat; git -C . status')).toEqual([
    'while read l@.1',
    'do cd /x@.1',
    'done@.1',
    'cat@.2',
    'git -C . status@',
  ])
})

// A `(` right behind a typed `<` or `>` opens a process substitution: the word is `/dev/fd/N`, and the `>` is no redirection of
// the command around it. Only a `>` that stands as a word of its own and has a process substitution as its target redirects.
test('splitShell reads >(...) as a word and > >(...) as a redirection', () => {
  expect(outMarks('tee >(a) x')).toEqual(['tee', 'a', 'x'])
  expect(outMarks('tee x>(a)')).toEqual(['tee x', 'a'])
  expect(outMarks('a > >(b)')).toEqual(['a >', 'b'])
  expect(outMarks('a >f >(b)')).toEqual(['a >', 'b >'])
  expect(outMarks('cat < <(a)')).toEqual(['cat', 'a $'])
  // A redirection after a process substitution is one of the whole command, so `diff` is marked (the inner marks are not read).
  expect(outMarks('diff <(a) <(b) > f').filter(m => !m.endsWith(' $'))).toEqual(['diff >'])
  // Only a `(` can open a process substitution. The `>` in front of a `$(` or a backtick is a redirection to the file that the
  // substitution names (`a > $(echo f)` writes to `f`), and it stays a redirection.
  expect(outMarks('docker run -d x > $(echo f)')).toEqual(['docker run -d x >', 'echo f $'])
  expect(outMarks('docker run -d x >$(echo f)')).toEqual(['docker run -d x >', 'echo f $'])
  expect(outMarks('docker run -d x > `echo f`')).toEqual(['docker run -d x >', 'echo f $'])
})

// The commands in `>(...)` read the pipe, and write where the command around the substitution writes (bash 5.3.20: `cat > >(a)
// </dev/null` prints what `a` prints). So `>(...)` is no `substituted` scope, unlike `<(...)`, whose commands write to the pipe.
// The marks come from the command around it: a redirection of its output before the substitution (`a >f > >(b)`), a group or a
// pipe around it, an earlier `exec`. The `>` whose target is the substitution itself (`a > >(b)`) is not one of them: `b` is
// created before that redirection takes effect. A redirection after the substitution (`a >(b) > f`) is one of the whole
// command, so `b` is marked too: the safe side, as bash creates `b` before it.
test('splitShell gives the commands in >(...) the output of the command around it', () => {
  // The target of the `>` is the substitution: the commands in it keep the output of the shell.
  expect(outMarks('cat > >(a)')).toEqual(['cat >', 'a'])
  expect(outMarks('cat 2> >(a)')).toEqual(['cat', 'a'])
  expect(outMarks('cat &> >(a)')).toEqual(['cat >', 'a'])
  expect(outMarks('cat > >(a) </dev/null; wait')).toEqual(['cat >', 'a', 'wait'])
  expect(outMarks('x | tee >(a)')).toEqual(['x |', 'tee', 'a'])
  expect(outMarks('cat > >(b | c)')).toEqual(['cat >', 'b |', 'c'])
  // An output substitution inside another one has the output of the shell too, and so does one in a group or `if`.
  expect(outMarks('cat > >(cat > >(a))')).toEqual(['cat >', 'cat >', 'a'])
  expect(outMarks('{ cat > >(a); }')).toEqual(['cat >', 'a'])
  expect(outMarks('if cat > >(a); then :; fi')).toEqual(['if cat >', 'a', 'then :', 'fi'])
  // The output of the command is redirected before the substitution: `a >f > >(b)` makes `b` write to the file `f`. A
  // substitution that stands in an argument is expanded before any redirection (`tee > f >(b)` prints `b`), but the safe side
  // marks it too. The same for a redirection after a command substitution that cut the command into segments.
  expect(outMarks('cat >f > >(a)')).toEqual(['cat >', 'a >'])
  expect(outMarks('cat >f >(a)')).toEqual(['cat >', 'a >'])
  expect(outMarks('cat > f >(a)')).toEqual(['cat >', 'a >'])
  expect(outMarks('cat > $(echo f) > >(a)')).toEqual(['cat >', 'echo f > $', 'a >'])
  expect(outMarks('cat >f $(echo x) > >(a)')).toEqual(['cat >', 'echo x > $', 'a >'])
  expect(outMarks('cat >f $(echo x) >(a)')).toEqual(['cat >', 'echo x $', 'a >'])
  expect(outMarks('cat >&2 > >(a)')).toEqual(['cat >', 'a >'])
  // A redirection of an earlier command is no redirection of this one. The substitution in a moved one is moved too.
  expect(outMarks('cat >f; tee >(a)')).toEqual(['cat >', 'tee', 'a'])
  expect(outMarks('cat >f && tee >(a) || tee >(b)')).toEqual(['cat >', 'tee', 'a', 'tee', 'b'])
  expect(outMarks('cat >f | cat > >(a)')).toEqual(['cat > |', 'cat >', 'a'])
  expect(outMarks('cat >f > >(tee >(a))')).toEqual(['cat >', 'tee >', 'a >'])
  expect(outMarks('cat >f > >(echo $(a))')).toEqual(['cat >', 'echo >', 'a > $'])
  // The first `> >(...)` is a redirection that took effect: the second substitution writes into the first one. A redirection
  // after a substitution is one of the whole command (the safe side), so the first one is marked too: bash prints `a`.
  expect(outMarks('cat > >(a) > >(b)')).toEqual(['cat >', 'a >', 'b >'])
  expect(outMarks('cat > >(a) >(b)')).toEqual(['cat >', 'a', 'b >'])
  // A redirection of stderr, of the input or of another descriptor leaves the output alone.
  expect(outMarks('cat 2>e > >(a)')).toEqual(['cat >', 'a'])
  expect(outMarks('cat 2>e 2> >(a)')).toEqual(['cat', 'a'])
  expect(outMarks('cat <in > >(a)')).toEqual(['cat >', 'a'])
  expect(outMarks('cat 3>f > >(a)')).toEqual(['cat >', 'a'])
  expect(outMarks('cat >&1 > >(a)')).toEqual(['cat >', 'a'])
  // The commands in it have a redirection of their own, or the command around it is piped, or its group is redirected.
  expect(outMarks('cat > >(a > f)')).toEqual(['cat >', 'a >'])
  expect(outMarks('cat > >({ a; } > f)')).toEqual(['cat >', 'a >'])
  expect(outMarks('cat > >(a) | b')).toEqual(['cat > |', 'a |', 'b'])
  expect(outMarks('tee >(a) | b')).toEqual(['tee |', 'a |', 'b'])
  expect(outMarks('{ cat > >(a); } > f')).toEqual(['cat >', 'a >'])
  expect(outMarks('( cat > >(a) ) | b')).toEqual(['cat > |', 'a |', 'b'])
  expect(outMarks('for i in 1; do cat > >(a); done > f')).toEqual(['for i in 1 >', 'do cat >', 'a >', 'done >'])
  expect(outMarks('cat > >(a) > f')).toEqual(['cat >', 'a >'])
  expect(outMarks('tee >(a) > f')).toEqual(['tee >', 'a >'])
  // An exec before it moves the output of the shell, and the substitution is a shell under it.
  expect(outMarks('exec > f; cat > >(a)')).toEqual(['exec >', 'cat >', 'a >'])
  expect(outMarks('exec > f; tee >(a)')).toEqual(['exec >', 'tee >', 'a >'])
  expect(outMarks('( exec > f ); cat > >(a)')).toEqual(['exec >', 'cat >', 'a'])
  // The shell takes the output of a substitution around it, and of an input substitution: the commands in them keep that.
  expect(outMarks('x=$(cat > >(a))')).toEqual(['x=', 'cat > $', 'a $'])
  expect(outMarks('echo `tee >(a)`')).toEqual(['echo', 'tee $', 'a $'])
  expect(outMarks('echo $(a > >(b > >(c)))')).toEqual(['echo', 'a > $', 'b > $', 'c $'])
  expect(outMarks('cat <(tee >(a))')).toEqual(['cat', 'tee $', 'a $'])
  expect(outMarks('cat < <(cat > >(a))')).toEqual(['cat', 'cat > $', 'a $'])
  // `<(...)` keeps its mark: its commands write to the pipe that the command reads.
  expect(outMarks('cat < <(a)')).toEqual(['cat', 'a $'])
  expect(outMarks('cat <(a) > >(b)')).toEqual(['cat >', 'a > $', 'b'])
  expect(outMarks('cat <(a) >(b)')).toEqual(['cat', 'a $', 'b'])
})

// A bare `exec` that redirects its output moves the output of the shell itself, so every later command of that shell prints
// elsewhere (issue #231). A subshell, a command substitution, a background list and a pipeline part are shells of their own:
// the redirection ends with them. `exec cmd > f` runs `cmd` in place of the shell, and the redirection is the command's.
test('splitShell marks the commands after a bare exec that redirects the standard output', () => {
  for (const exec of [
    'exec > f',
    'exec >f',
    'exec >> f',
    'exec 1> f',
    'exec &> f',
    'exec &>> f',
    'exec >&2',
    'exec 3>&1 >/dev/null',
  ])
    expect({ exec, marks: outMarks(`a; ${exec}; b; c`) }).toEqual({ exec, marks: ['a', 'exec >', 'b >', 'c >'] })
  expect(outMarks('exec>f; a')).toEqual(['exec >', 'a >'])
  expect(outMarks("'exec' > f; a")).toEqual(['exec >', 'a >'])
  expect(outMarks('exec > f && a || b\nc')).toEqual(['exec >', 'a >', 'b >', 'c >'])
  expect(outMarks('if exec > f; then a; fi; b')).toEqual(['if exec >', 'then a >', 'fi >', 'b >'])
  expect(outMarks('{ exec > f; }; a')).toEqual(['exec >', 'a >'])
  expect(outMarks('for i in 1; do exec > f; a; done; b')).toEqual(['for i in 1', 'do exec >', 'a >', 'done >', 'b >'])
  expect(outMarks('exec > f; ( a; ( b ) ); { c; }')).toEqual(['exec >', 'a >', 'b >', 'c >'])
  // The first exec of a shell counts for all the later segments, and a second one changes nothing.
  expect(outMarks('exec > f; a; exec > g; b')).toEqual(['exec >', 'a >', 'exec >', 'b >'])
  // An exec in a parent shell reaches a subshell that sits two levels down, and the commands after the subshell.
  expect(outMarks('( exec > f; ( a ) ); b')).toEqual(['exec >', 'a >', 'b'])
  expect(outMarks('( exec > f; ( ( a ) ) ); b')).toEqual(['exec >', 'a >', 'b'])
})

// The options of `exec` (`-c`, `-l`, `-a name`) only matter when a command follows. With none, the redirection still moves the
// shell itself, as in bash 5.3: `exec -c > f; echo hidden` writes `hidden` to `f`. `--` ends the options.
test('splitShell marks the commands after a bare exec that has only options', () => {
  for (const [exec, shown] of [
    ['exec -c > f', 'exec -c'],
    ['exec -l > f', 'exec -l'],
    ['exec -a name > f', 'exec -a name'],
    ['exec -cl > f', 'exec -cl'],
    ['exec -cla name > f', 'exec -cla name'],
    ['exec -anm > f', 'exec -anm'],
    ['exec -c -l > f', 'exec -c -l'],
    ['exec -c -a name -l >> f', 'exec -c -a name -l'],
    ['exec -- > f', 'exec --'],
    ['exec -c -- &> f', 'exec -c --'],
    ['exec -a n -- > f', 'exec -a n --'],
    ['exec -a n -c > f', 'exec -a n -c'],
    ['command exec -c > f', 'command exec -c'],
  ] as const)
    expect({ exec, marks: outMarks(`a; ${exec}; b; c`) }).toEqual({ exec, marks: ['a', `${shown} >`, 'b >', 'c >'] })
  // The options leave the output alone when no redirection of it comes, or when a command follows: `exec -c a > f` runs `a`.
  for (const exec of [
    'exec -c',
    'exec -a name',
    'exec -c 2> f',
    'exec -c < f',
    'exec -c a > f',
    'exec -a name a > f',
    'exec -c -- a > f',
    'exec -- -c > f',
    'exec - > f',
    'exec -anm a > f',
    // The options belong to the wrapper that `exec` runs (`time`, `command`), not to `exec`.
    'exec time -c > f',
    'exec command -l > f',
    // A redirection in front of `-p` ends the options of `time` (issue #227): `-p` is the command, and `exec` is its argument.
    'time >/dev/null -p exec > f',
  ])
    expect({ exec, later: outMarks(`${exec}; b`).at(-1) }).toEqual({ exec, later: 'b' })
  // A word that is no option of `exec` is a command, as in bash: `exec -x > f` is an error and moves nothing.
  expect(outMarks('exec -x > f; b')).toEqual(['exec -x >', 'b'])
  // `-a` with no name is an error in bash too, and the redirection is not applied. The reader marks it all the same, the safe side.
  expect(outMarks('exec -a > f; b')).toEqual(['exec -a >', 'b >'])
})

test('splitShell leaves the commands after an exec that does not move the standard output alone', () => {
  for (const exec of [
    'exec',
    'exec 2> f',
    'exec 2>&1',
    'exec 3> f',
    'exec 3>&1',
    'exec < f',
    'exec {fd}> f',
    'exec <> f',
  ])
    expect({ exec, marks: outMarks(`${exec}; a; b`) }).toEqual({ exec, marks: ['exec', 'a', 'b'] })
})

test('splitShell ends the redirection of an exec with the shell it ran in', () => {
  expect(outMarks('( exec > f ); a')).toEqual(['exec >', 'a'])
  expect(outMarks('( exec > f; a ); b')).toEqual(['exec >', 'a >', 'b'])
  expect(outMarks('x=$(exec > f); a')).toEqual(['x=', 'exec > $', 'a'])
  expect(outMarks('exec > f & a')).toEqual(['exec >', 'a'])
  expect(outMarks('exec > f | cat; a')).toEqual(['exec > |', 'cat', 'a'])
  expect(outMarks('a | exec > f; b')).toEqual(['a |', 'exec >', 'b'])
  expect(outMarks('{ exec > f; } & a')).toEqual(['exec >', 'a'])
  // A command that `exec` runs in place of the shell has the redirection of its own, and a word `exec` is no exec.
  expect(outMarks('exec a > f; b')).toEqual(['exec a >', 'b'])
  expect(outMarks('echo exec > f; a')).toEqual(['echo exec >', 'a'])
  // A command before the exec keeps what it had.
  expect(outMarks('a; exec > f')).toEqual(['a', 'exec >'])
})

// A group, loop or `if` that redirects the output saves fd 1 and gives it back at its end, so an `exec` inside it moves the
// output only up to there (bash 5.3.20: `{ exec >/dev/null; } >/dev/null; echo after` prints `after`). A group that redirects
// something else (stderr, the input, fd 3) saves no fd 1, and an unredirected group is the shell itself: the exec stays.
test('splitShell ends the redirection of an exec where the redirected group or compound around it ends', () => {
  for (const redir of ['> g', '>g', '>> g', '>| g', '&> g', '&>> g', '1> g', '>&2'])
    expect({ redir, marks: outMarks(`{ exec > f; } ${redir}; a`) }).toEqual({ redir, marks: ['exec >', 'a'] })
  expect(outMarks('{ exec > f; a; } > g; b')).toEqual(['exec >', 'a >', 'b'])
  expect(outMarks('{ exec > f; } > g && a')).toEqual(['exec >', 'a'])
  expect(outMarks('{ exec -c > f; } > g; a')).toEqual(['exec -c >', 'a'])
  expect(outMarks('( exec > f ) > g; a')).toEqual(['exec >', 'a'])
  expect(outMarks('for i in 1; do exec > f; done > g; a')).toEqual(['for i in 1 >', 'do exec >', 'done >', 'a'])
  expect(outMarks('while c; do exec > f; break; done > g; a')).toEqual([
    'while c >',
    'do exec >',
    'break >',
    'done >',
    'a',
  ])
  expect(outMarks('if c; then exec > f; fi > g; a')).toEqual(['if c >', 'then exec >', 'fi >', 'a'])
  expect(outMarks('case x in x) exec > f;; esac > g; a')).toEqual(['case x in >', 'exec >', 'esac >', 'a'])
  // An exec in the condition of a redirected compound is inside it, as the first segment of the range.
  expect(outMarks('if exec > f; then a; fi > g; b')).toEqual(['if exec >', 'then a >', 'fi >', 'b'])
  expect(outMarks('while exec > f; do a; done > g; b')).toEqual(['while exec >', 'do a >', 'done >', 'b'])
  // A group that is redirected deeper in keeps what is outside of it: the exec ends at the first redirected group around it.
  expect(outMarks('{ { exec > f; } > g; a; }; b')).toEqual(['exec >', 'a', 'b'])
  expect(outMarks('{ { exec > f; }; a; } > g; b')).toEqual(['exec >', 'a >', 'b'])
  expect(outMarks('if c; then { exec > f; }; fi > g; a')).toEqual(['if c >', 'then >', 'exec >', 'fi >', 'a'])
  expect(outMarks('( { exec > f; } > g; a ); b')).toEqual(['exec >', 'a', 'b'])
  // An exec before the redirected group still reaches what comes after it, and a second exec inside it changes nothing.
  expect(outMarks('exec > f; { a; } > g; b')).toEqual(['exec >', 'a >', 'b >'])
  expect(outMarks('exec > f; { exec > g; } > h; b')).toEqual(['exec >', 'exec >', 'b >'])
  // Every exec inside the group ends with it, not only the last one.
  expect(outMarks('{ exec > f; exec > g; } > h; a')).toEqual(['exec >', 'exec >', 'a'])
  expect(outMarks('for i in 1; do exec > f; exec > g; done > h; a')).toEqual([
    'for i in 1 >',
    'do exec >',
    'exec >',
    'done >',
    'a',
  ])
  // A later exec of the shell marks again after the group.
  expect(outMarks('{ exec > f; } > g; a; exec > h; b')).toEqual(['exec >', 'a', 'exec >', 'b >'])
})

test('splitShell keeps the redirection of an exec when the group or compound around it moves no fd 1', () => {
  // An unredirected group or compound is the shell itself, so the exec stays for the commands after it.
  expect(outMarks('{ exec > f; }; a')).toEqual(['exec >', 'a >'])
  expect(outMarks('for i in 1; do exec > f; done; a')).toEqual(['for i in 1', 'do exec >', 'done >', 'a >'])
  expect(outMarks('{ { exec > f; }; }; a')).toEqual(['exec >', 'a >'])
  // A redirection of stderr, of the input or of another descriptor saves no fd 1: bash 5.3.20 keeps the exec after it.
  for (const redir of ['2> g', '2>&1', '< g', '<<< x', '3>&1', '{fd}> g', '12> g'])
    expect({ redir, marks: outMarks(`{ exec > f; } ${redir}; a`) }).toEqual({ redir, marks: ['exec >', 'a >'] })
  expect(outMarks('for i in 1; do exec > f; done 2> g; a')).toEqual(['for i in 1', 'do exec >', 'done >', 'a >'])
  expect(outMarks('while c; do exec > f; break; done < g; a')).toEqual([
    'while c',
    'do exec >',
    'break >',
    'done >',
    'a >',
  ])
  // A redirection in front of the group, on the command before it, is not the group's.
  expect(outMarks('a > g; { exec > f; }; b')).toEqual(['a >', 'exec >', 'b >'])
  // A redirected group before the exec ends nothing: the exec comes after it.
  expect(outMarks('{ a; } > g; exec > f; b')).toEqual(['a >', 'exec >', 'b >'])
})

// The compound that closes with a redirection (`done > g`) ends the execs inside it from its own first segment, and no earlier
// one: an exec in front of it keeps its mark for the commands after it, and a command in front of it is not marked. These rows
// pin the bound at the close of a compound, the same way the rows with `{ }` above pin it at the close of a group.
test('splitShell ends only the execs inside a redirected compound, not one in front of it', () => {
  expect(outMarks('exec > f; for i in 1; do a; done > g; b')).toEqual([
    'exec >',
    'for i in 1 >',
    'do a >',
    'done >',
    'b >',
  ])
  expect(outMarks('exec > f; while c; do a; break; done > g; b')).toEqual([
    'exec >',
    'while c >',
    'do a >',
    'break >',
    'done >',
    'b >',
  ])
  expect(outMarks('exec > f; if c; then a; fi > g; b')).toEqual(['exec >', 'if c >', 'then a >', 'fi >', 'b >'])
  expect(outMarks('exec > f; case x in x) a;; esac > g; b')).toEqual(['exec >', 'case x in >', 'a >', 'esac >', 'b >'])
  // A command in front of the compound is no part of its range.
  expect(outMarks('x; for i in 1; do a; done > g; b')).toEqual(['x', 'for i in 1 >', 'do a >', 'done >', 'b'])
  expect(outMarks('x; while c; do a; break; done > g; b')).toEqual([
    'x',
    'while c >',
    'do a >',
    'break >',
    'done >',
    'b',
  ])
  expect(outMarks('x; if c; then a; fi > g; b')).toEqual(['x', 'if c >', 'then a >', 'fi >', 'b'])
  expect(outMarks('x; case x in x) a;; esac > g; b')).toEqual(['x', 'case x in >', 'a >', 'esac >', 'b'])
})

// `>&1` copies fd 1 onto itself: bash saves nothing and changes nothing (5.3.20: `{ exec >/dev/null; } >&1; echo after` prints
// nothing, and `echo hi >&1` prints). It is no redirection of fd 1, so it ends no exec, and it marks no segment.
test('splitShell reads a copy of fd 1 onto itself as no redirection, so an exec stays after it', () => {
  for (const same of ['>&1', '1>&1', '>& 1', '1>& 1', '>&01', '>&1-', '>&"1"', "1>&'1'"])
    expect({ same, marks: outMarks(`{ exec > f; } ${same}; a`) }).toEqual({ same, marks: ['exec >', 'a >'] })
  expect(outMarks('for i in 1; do exec > f; done >&1; a')).toEqual(['for i in 1', 'do exec >', 'done >', 'a >'])
  expect(outMarks('if c; then exec > f; fi >&1; a')).toEqual(['if c', 'then exec >', 'fi >', 'a >'])
  expect(outMarks('case x in x) exec > f;; esac >&1; a')).toEqual(['case x in', 'exec >', 'esac >', 'a >'])
  // Another redirection of fd 1 on the same group still ends the exec, before or after the copy.
  expect(outMarks('{ exec > f; } >&1 > g; a')).toEqual(['exec >', 'a'])
  expect(outMarks('{ exec > f; } > g >&1; a')).toEqual(['exec >', 'a'])
  expect(outMarks('{ exec > f; } >&1 2>&2 &> g; a')).toEqual(['exec >', 'a'])
  // A copy of another descriptor onto fd 1 moves it: `>&2` ends the exec, as the rows above show, and so do `>&0`, `>&-`, `>&10`.
  for (const moved of ['>&0', '>&-', '>&10', '>&11', '>&1x', '1>&2', '1>&-'])
    expect({ moved, marks: outMarks(`{ exec > f; } ${moved}; a`) }).toEqual({ moved, marks: ['exec >', 'a'] })
  // `exec >&1` puts nothing away, and a run after it prints: bash 5.3.20 `exec >&1; echo hi` prints `hi`.
  expect(outMarks('exec >&1; a')).toEqual(['exec', 'a'])
  expect(outMarks('exec 1>&1; a')).toEqual(['exec', 'a'])
  expect(outMarks('exec >& 1; a')).toEqual(['exec', 'a'])
})

test('splitShell marks no redirection of the standard output for stderr, input and other descriptors', () => {
  for (const redir of [
    '2> f',
    '2>f',
    '2>> f',
    '2>&1',
    '2>/dev/null',
    '3> f',
    '3>&1',
    '< f',
    '<f',
    '<<< x',
    '<> f',
    '0<> f',
    '{fd}> f',
    '{fd}>&2',
    '{fd}<> f',
    '12> f',
    // A copy of fd 1 onto itself puts nothing away (bash 5.3.20 `echo hi >&1` prints). The target is the next word when spaced.
    '>&1',
    '1>&1',
    '>& 1',
    '1>& 1',
    '>&01',
    '>&1-',
    '<&1',
    '1<&1',
    '>&"1"',
    "1>&'1'",
    '2>& 1',
    '3>& 1',
  ])
    expect({ redir, marks: outMarks(`docker run -d x ${redir}`) }).toEqual({ redir, marks: ['docker run -d x'] })
  // A quoted or escaped `>` is a word (issue #162), not a redirection.
  expect(outMarks("docker run -d x '>' f")).toEqual(['docker run -d x > f'])
  expect(outMarks('docker run -d x \\> f')).toEqual(['docker run -d x > f'])
  expect(outMarks('docker run -d x ">>" f')).toEqual(['docker run -d x >> f'])
  expect(outMarks("docker run -d x 1'>' f")).toEqual(['docker run -d x 1> f'])
})

test('splitShell marks the redirection on the segment it stands on, not on its neighbours', () => {
  expect(outMarks('a > f; b; c >> g')).toEqual(['a >', 'b', 'c >'])
  expect(outMarks('a > f && b || c &> g')).toEqual(['a >', 'b', 'c >'])
  expect(outMarks('a 2> f\nb > g')).toEqual(['a', 'b >'])
  // A heredoc is a redirection of the input. Its body is no command.
  expect(outMarks('cat <<EOF\ndocker run -d x\nEOF\nb')).toEqual(['cat', 'b'])
  // The pipe marks the part before it, and a redirection marks its own part.
  expect(outMarks('a > f | b')).toEqual(['a > |', 'b'])
  expect(outMarks('a | b > f')).toEqual(['a |', 'b >'])
})

test('splitShell marks the whole group, subshell or loop that has the redirection', () => {
  expect(outMarks('{ a; b; } > f')).toEqual(['a >', 'b >'])
  expect(outMarks('{ a; b; } > f; c')).toEqual(['a >', 'b >', 'c'])
  expect(outMarks('{ a; } 2>&1 > f')).toEqual(['a >'])
  expect(outMarks('( a; b ) >> f')).toEqual(['a >', 'b >'])
  expect(outMarks('( a; b ) &> f && c')).toEqual(['a >', 'b >', 'c'])
  expect(outMarks('x; { a; } > f')).toEqual(['x', 'a >'])
  expect(outMarks('for i in 1; do a; done > f')).toEqual(['for i in 1 >', 'do a >', 'done >'])
  expect(outMarks('if a; then b; fi > f; c')).toEqual(['if a >', 'then b >', 'fi >', 'c'])
  expect(outMarks('while a; do b; done >| f')).toEqual(['while a >', 'do b >', 'done >'])
  expect(outMarks('case $x in y) a;; esac > f')).toEqual(['case $x in >', 'a >', 'esac >'])
  expect(outMarks('{ { a; } > f; b; }')).toEqual(['a >', 'b'])
  expect(outMarks('{ a; } > f | b')).toEqual(['a > |', 'b'])
  // A redirection of stderr or of the input leaves the output alone, and so does a command of its own after the group.
  expect(outMarks('{ a; } 2> f')).toEqual(['a'])
  expect(outMarks('{ a; } < f')).toEqual(['a'])
  expect(outMarks('{ a; }; > f')).toEqual(['a'])
  expect(outMarks('{ a; } && > f')).toEqual(['a'])
  expect(outMarks('for i in 1; do a; done 2> f')).toEqual(['for i in 1', 'do a', 'done'])
  // A redirection inside the group stays on its segment.
  expect(outMarks('{ a > f; b; }')).toEqual(['a >', 'b'])
  expect(outMarks('for i in 1; do a > f; b; done')).toEqual(['for i in 1', 'do a >', 'b', 'done'])
})

// A substitution splits a simple command into segments: `a $(b) c > f` is `a`, `b` (inside) and `c > f`. A redirection or a
// pipe after it is one of the whole command, so `a` is marked too. The marks of the segments inside the substitution are
// not read: the shell takes their output anyway.
test('splitShell marks the head of a command that a substitution split, when a redirection or a pipe comes after', () => {
  const outer = (cmd: string) => outMarks(cmd).filter(m => !m.endsWith(' $'))
  expect(outer('a $(b) > f')).toEqual(['a >'])
  expect(outer('a $(b) c > f')).toEqual(['a >', 'c >'])
  expect(outer('a `b` c > f')).toEqual(['a >', 'c >'])
  expect(outer('a $(b) $(c) d >> f')).toEqual(['a >', 'd >'])
  expect(outer('a -e T=$(b) c > f')).toEqual(['a -e T= >', 'c >'])
  expect(outer('a <(b) c &> f')).toEqual(['a >', 'c >'])
  expect(outer('a $(b) c | d')).toEqual(['a |', 'c |', 'd'])
  expect(outer('a $(b) c 2>&1 | d')).toEqual(['a |', 'c |', 'd'])
  // A redirection before the substitution marks the head already, and one of stderr marks nothing.
  expect(outer('a > f $(b) c')).toEqual(['a >', 'c'])
  expect(outer('a $(b) c 2> f')).toEqual(['a', 'c'])
  expect(outer('a $(b) c < f')).toEqual(['a', 'c'])
  // The command ends at an operator: what comes after is another command.
  expect(outer('a $(b) c; d > f')).toEqual(['a', 'c', 'd >'])
  expect(outer('a $(b) c && d > f')).toEqual(['a', 'c', 'd >'])
  expect(outer('a $(b) c\nd > f')).toEqual(['a', 'c', 'd >'])
  expect(outer('a $(b) c & d > f')).toEqual(['a', 'c', 'd >'])
  expect(outer('a $(b) c; { d; } > f')).toEqual(['a', 'c', 'd >'])
  expect(outer('a $(b) c; ( d ) > f')).toEqual(['a', 'c', 'd >'])
  // A subshell is no substitution: the keyword in front of it is another command, and the redirection is the subshell's alone.
  expect(outer('for i in 1; do ( a ) > f; done')).toEqual(['for i in 1', 'do', 'a >', 'done'])
  // A redirection inside the substitution is the inner command's, not the outer one's.
  expect(outer('a $(b > g) c')).toEqual(['a', 'c'])
  expect(outer('a $(b $(c) > g) d')).toEqual(['a', 'd'])
  expect(outer('a $(b; c > g) d')).toEqual(['a', 'd'])
  // The part of a command that comes before the substitution is not marked by a redirection of an earlier command.
  expect(outer('x > f; a $(b) c')).toEqual(['x >', 'a', 'c'])
  // A command that opens with a substitution has no head before it: the redirection marks no earlier command.
  expect(outer('a; $(b) > f')).toEqual(['a'])
  expect(outer('a && $(b) > f')).toEqual(['a'])
  expect(outer('a\n$(b) > f')).toEqual(['a'])
  // A second substitution does not move the head of the command: it stays at its first segment.
  expect(outer('a $(b) c $(d) e > f')).toEqual(['a >', 'c >', 'e >'])
})

test('splitShell marks every part of a pipeline except the last as piped', () => {
  expect(outMarks('a | b')).toEqual(['a |', 'b'])
  expect(outMarks('a |& b')).toEqual(['a |', 'b'])
  expect(outMarks('a | b | c')).toEqual(['a |', 'b |', 'c'])
  expect(outMarks('echo x | docker run -d y')).toEqual(['echo x |', 'docker run -d y'])
  // The pipeline is one part of the and-or list: the commands around it are not piped.
  expect(outMarks('a && b | c || d')).toEqual(['a', 'b |', 'c', 'd'])
  expect(outMarks('a; b | c; d')).toEqual(['a', 'b |', 'c', 'd'])
  expect(outMarks('a\nb | c\nd')).toEqual(['a', 'b |', 'c', 'd'])
  expect(outMarks('a & b | c')).toEqual(['a', 'b |', 'c'])
  // `>|` is a redirection and `||` an or-list: neither pipes.
  expect(outMarks('a >| f')).toEqual(['a >'])
  expect(outMarks('a || b')).toEqual(['a', 'b'])
  // A pipe that was quoted or escaped is a word.
  expect(outMarks("a '|' b")).toEqual(['a | b'])
  expect(outMarks('a \\| b')).toEqual(['a | b'])
})

test('splitShell marks the whole group, subshell or loop in front of a pipe as piped', () => {
  expect(outMarks('{ a; b; } | c')).toEqual(['a |', 'b |', 'c'])
  expect(outMarks('( a; b ) | c')).toEqual(['a |', 'b |', 'c'])
  expect(outMarks('for i in 1; do a; done | c')).toEqual(['for i in 1 |', 'do a |', 'done |', 'c'])
  expect(outMarks('if a; then b; fi | c')).toEqual(['if a |', 'then b |', 'fi |', 'c'])
  expect(outMarks('x && { a; } | c')).toEqual(['x', 'a |', 'c'])
  expect(outMarks('{ a; } | c; d')).toEqual(['a |', 'c', 'd'])
  // A pipe inside the group marks the segments of its own part only.
  expect(outMarks('{ a | b; c; }')).toEqual(['a |', 'b', 'c'])
  expect(outMarks('for i in 1; do a | b; c; done')).toEqual(['for i in 1', 'do a |', 'b', 'c', 'done'])
})

test('splitShell reads the | between the patterns of a case as no pipe', () => {
  expect(outMarks('case $x in a|b) c;; d) e | f;; esac')).toEqual(['case $x in', 'c', 'e |', 'f', 'esac'])
})

test('splitShell marks a segment inside a command substitution, backticks or a process substitution', () => {
  expect(outMarks('echo $(a)')).toEqual(['echo', 'a $'])
  expect(outMarks('echo `a`')).toEqual(['echo', 'a $'])
  // The text in backticks is a command, no arithmetic: a glued `>` in it is a redirection.
  expect(outMarks('echo `a>f`')).toEqual(['echo', 'a > $'])
  expect(outMarks('x=$(a; b) c')).toEqual(['x=', 'a $', 'b $', 'c'])
  expect(outMarks('echo $(a $(b) c) d')).toEqual(['echo', 'a $', 'b $', 'c $', 'd'])
  expect(outMarks('echo $( ( a ) )')).toEqual(['echo', 'a $'])
  expect(outMarks('echo $( { a; } )')).toEqual(['echo', 'a $'])
  expect(outMarks('diff <(a) <(b) c')).toEqual(['diff', 'a $', 'b $', 'c'])
  expect(outMarks('cat < <(a)')).toEqual(['cat', 'a $'])
  // The shell takes no output of `>(a)`: its standard output is the one of the command around it (see the test of `>(...)`).
  expect(outMarks('tee >(a) x')).toEqual(['tee', 'a', 'x'])
  // A subshell, a group and a background list capture nothing: their output goes where the shell's own goes.
  expect(outMarks('( a ); { b; }; c &')).toEqual(['a', 'b', 'c'])
  // A pipe or a redirection inside the substitution marks its own segments too.
  expect(outMarks('x=$(a | b)')).toEqual(['x=', 'a | $', 'b $'])
  expect(outMarks('x=$(a > f)')).toEqual(['x=', 'a > $'])
})

// A subshell drops the segment of no words at its end (`Segment.bg`). A pipe or a redirection of a group inside it that ended behind
// that segment now ends at the new end, so the command after the subshell is no part of it: `( cat <(a) | > f ); b` and
// `( { cat <(a); } > f ); b` print `b` where the shell prints, and a run in `b` keeps its id.
test('splitShell ends a pipe or a redirection at the new end of a subshell that dropped a segment with no words', () => {
  expect(outMarks('( cat <(a) | > f ); b')).toEqual(['cat |', 'a | $', 'b'])
  expect(outMarks('( { cat <(a); } > f ); b')).toEqual(['cat >', 'a > $', 'b'])
  expect(outMarks('x=$( cat <(a) | > f ); b')).toEqual(['x=', 'cat | $', 'a | $', 'b'])
})

// One named rule for the three marks, so a reader cannot read two of them and bring the bug of #231 back unseen.
test('keepsStdout is true only for a segment that has none of the three marks', () => {
  const none = { stdoutRedirected: false, stdoutPiped: false, substituted: false }
  expect(keepsStdout(none)).toBe(true)
  expect(keepsStdout({ ...none, stdoutRedirected: true })).toBe(false)
  expect(keepsStdout({ ...none, stdoutPiped: true })).toBe(false)
  expect(keepsStdout({ ...none, substituted: true })).toBe(false)
  // The rule reads the marks of the splitter: a plain command keeps its output, the others lose it.
  expect(splitShell('a; b > f; c | d; e $(f)').map(s => [s.words[0], keepsStdout(s)])).toEqual([
    ['a', true],
    ['b', false],
    ['c', false],
    ['d', true],
    ['e', true],
    ['f', false],
  ])
})

// The redirection of a group is a range over the segments, read once at the end. A redirection on each of a deep nest of
// groups would otherwise mark every inner segment again (issue #231): 4 times the input would cost 16 times as much.
const MARK_FAMILIES: Record<string, (k: number) => string> = {
  'nested redirected groups': k => '{ a; '.repeat(1_000 * k) + 'a' + '; } > f'.repeat(1_000 * k),
  'nested redirected loops': k => 'for i in 1; do a; '.repeat(500 * k) + 'a' + '; done > f'.repeat(500 * k),
  'a long pipeline': k => 'a | '.repeat(5_000 * k) + 'a',
  // A word that ends at each glued `>`, an open `${` that keeps its `>` as text, and a list of bare exec segments.
  'glued redirections': k => 'a>'.repeat(10_000 * k) + 'b',
  'an open parameter expansion with many redirections': k => '${x' + ':-a>'.repeat(10_000 * k) + '}',
  'bare exec segments': k => 'exec > f; a; '.repeat(5_000 * k) + 'b',
  // Each redirected group ends the execs inside it. A close that reads every exec of the list again (`execs.filter`, in place
  // of popping the last ones) costs O(n) per close, so a nest of n groups costs O(n^2). Only the nest can show that: it holds
  // n execs at its deepest close. At 1_000 groups that part stays under twice the linear part (the rule of scaling.ts, "Pick
  // a base size") and the ratio stays under the limit, so the nest is 6_000 groups. A list of groups keeps one exec at a time,
  // so it sees no such cost (a scan over the kept execs stays under the limit at 3_000 groups too). It checks only that a long
  // list of closes stays flat.
  'nested redirected groups that each hold an exec': k =>
    '{ exec > f; '.repeat(6_000 * k) + 'a' + '; } > g'.repeat(6_000 * k),
  'a list of redirected groups that each hold an exec': k => '{ exec > f; } > g; a; '.repeat(3_000 * k) + 'b',
  // An output substitution reads the redirection before it and gives it back at its close: a nest, and a list in one command.
  'nested output substitutions after a redirection': k => 'a >f > >('.repeat(3_000 * k) + 'a' + ')'.repeat(3_000 * k),
  'a list of output substitutions in one command': k => 'a >f ' + '>(a) '.repeat(5_000 * k) + 'b',
}
for (const [family, make] of Object.entries(MARK_FAMILIES)) {
  test(`splitShell stays linear on ${family}`, async () => {
    await expectLinear({ label: family, make, run: text => splitShell(text) })
  })
}
