// A small shell reader for the process parser. It splits one Bash command into simple commands.
// Not a full shell: enough to find `docker run -d`, `tmux new -d` and friends inside compound commands.
// Quoted text stays one word, so `bash -c '...'`, `ssh host '...'` and `echo "...; ..."` hide their insides.
// Heredoc bodies and comments are skipped.

/**
 * Stands for a `$` that the shell passes as typed: one inside single quotes, after a backslash or after a backslash in
 * double quotes. `Segment.marked` holds it, so a reader that expands `$NAME` can tell `'$F'` from `$F`. A shell command
 * line has no NUL (an argument cannot hold one), so no typed character is taken for it.
 */
export const LITERAL_DOLLAR = '\u0000'

/** The word as the shell passes it: each `LITERAL_DOLLAR` is a plain `$` again. */
export const unmarkDollars = (word: string): string => word.replaceAll(LITERAL_DOLLAR, '$')

const literalDollars = (text: string): string => text.replaceAll('$', LITERAL_DOLLAR)

export type Segment = {
  /** Words with quotes and escapes removed. Redirections are dropped. */
  words: string[]
  /**
   * The same words, with each `$` that quotes or an escape made literal replaced by `LITERAL_DOLLAR`. Quotes and escapes
   * are gone from `words`, so only this array says which `$NAME` the shell expands (bare, or in double quotes) and which
   * it passes on as typed (`'$NAME'`, `\$NAME`). Same length and order as `words`.
   */
  marked: string[]
  /** The segment ended with a single `&`: the shell runs it in the background. */
  bg: boolean
  /**
   * The subshell the segment runs in. `''` is the top level. `(`, `$(` and a backtick pair open a child scope
   * `${parent}.${n}`. `{ }` is the same shell, so it keeps the scope. A list that ends with `&` runs in a subshell
   * too, so its segments get a child scope of their own (see `splitShell`).
   */
  scope: string
}

// A compound command spans several segments: `for ...; do ...; done`. `COMPOUND_LEAD` are the reserved words that can
// stand in front of the opener (`do for`, `then if`, `else if`). `time` and its options (`time -p for ...`) can too.
const COMPOUND_OPEN = new Set(['for', 'while', 'until', 'if', 'case', 'select'])
const COMPOUND_CLOSE = new Set(['done', 'fi', 'esac'])
const COMPOUND_LEAD = new Set(['!', 'do', 'then', 'else'])

/** The word that starts the command of a segment, behind the reserved words and `time [-p]`. */
function compoundHead(words: readonly string[]): string | undefined {
  let afterTime = false
  for (const w of words) {
    if (COMPOUND_LEAD.has(w)) afterTime = false
    else if (w === 'time') afterTime = true
    else if (!(afterTime && w.startsWith('-'))) return w
  }
  return undefined
}

const OPS = ['&&', '||', '|&', ';', '|', '&', '\n', '(', ')', '`', '$(', '{', '}'] as const

/**
 * Splits `command` into simple commands on `;`, `&&`, `||`, `|`, `&`, newlines, subshells and groups.
 * A list that ends with `&` (`cd x && npm start &`, `{ cd x; } &`, `for ...; do cd x; done &`) runs in a background
 * subshell. Its segments move to a child scope, so a `cd` in it does not reach the segments after the `&` (issue #141).
 */
export function splitShell(command: string): Segment[] {
  const out: Segment[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const heredocs: { tag: string; strip: boolean }[] = []
  let i = 0
  const s = command
  // Open subshells, innermost last. The segment ends before a scope opens or closes, so it keeps the scope it ran in.
  // `from` is the `listFrom` of the scope that opened it.
  const stack: { id: string; tick: boolean; from: number }[] = []
  let scopes = 0
  const scope = () => stack.at(-1)?.id ?? ''
  // The first segment of the and-or list that the next `&`, `;` or newline ends. `&&` and `||` keep it, and a newline
  // right after `&&`, `||` or `|` keeps it too (`wantsMore`). A group saves the list it sits in and opens one of its own:
  // `}` gives the outer list back, so `{ a; } && b &` stays one list. A `for`, `while`, `until`, `if`, `case` or `select`
  // does the same in `compounds`: its `;` inside reset the list, so `done`, `fi` or `esac` gives back the list that
  // holds the whole compound, and the `&` after it backgrounds the loop as a unit.
  let listFrom = 0
  const groups: number[] = []
  const compounds: number[] = []
  // The last operator was `&&`, `||`, `|` or `|&` and no word has come after it: the list goes on after a newline.
  let wantsMore = false
  // A scope opens a list of its own. Its close gives back the list it sat in.
  const openScope = (tick: boolean) => {
    stack.push({ id: `${scope()}.${++scopes}`, tick, from: listFrom })
    listFrom = out.length
  }
  const closeScope = () => {
    const top = stack.pop()
    if (top) listFrom = top.from
  }
  // The list from `from` runs in the background. Its segments move to a child of the current scope. Every segment of
  // the list sits in that scope or in a scope under it.
  const backgroundFrom = (from: number) => {
    const parent = scope()
    const child = `${parent}.${++scopes}`
    for (const seg of out.slice(from)) {
      if (seg.scope === parent || seg.scope.startsWith(`${parent}.`)) seg.scope = child + seg.scope.slice(parent.length)
    }
  }

  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = (bg: boolean) => {
    endWord()
    const clean = dropRedirections(words)
    if (clean.length > 0) {
      out.push({ words: clean.map(unmarkDollars), marked: clean, bg, scope: scope() })
      const head = compoundHead(clean)
      if (head !== undefined && COMPOUND_OPEN.has(head)) compounds.push(listFrom)
      else if (COMPOUND_CLOSE.has(clean[0]!)) listFrom = compounds.pop() ?? listFrom
    }
    words = []
  }
  const skipHeredocs = () => {
    // At a newline: skip each pending heredoc body up to its tag line.
    for (const h of heredocs) {
      while (i < s.length) {
        const nl = s.indexOf('\n', i)
        const line = s.slice(i, nl === -1 ? s.length : nl)
        i = nl === -1 ? s.length : nl + 1
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.tag) break
      }
    }
    heredocs.length = 0
  }

  while (i < s.length) {
    const c = s[i]!
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2
        continue
      }
      word += literalDollars(s[i + 1] ?? '')
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      word += literalDollars(s.slice(i + 1, end === -1 ? s.length : end))
      inWord = true
      i = end === -1 ? s.length : end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) {
          word += literalDollars(s[j + 1]!)
          j += 2
          continue
        }
        word += s[j]
        j++
      }
      inWord = true
      i = j + 1
      continue
    }
    if (c === '#' && !inWord) {
      const nl = s.indexOf('\n', i)
      i = nl === -1 ? s.length : nl
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }
    // Heredoc: `<<TAG`, `<<-TAG`, `<<'TAG'`. The body starts after the next newline.
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      endWord()
      let j = i + 2
      const strip = s[j] === '-'
      if (strip) j++
      while (s[j] === ' ' || s[j] === '\t') j++
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(s.slice(j))
      if (m) {
        heredocs.push({ tag: m[2]!, strip })
        i = j + m[0].length
        continue
      }
      i += 2
      continue
    }
    // `&` inside a redirection (`2>&1`, `>&2`, `&>file`, `&>>file`) is not an operator.
    if (c === '&' && (word.endsWith('>') || word.endsWith('<') || s[i + 1] === '>')) {
      word += c
      inWord = true
      i++
      continue
    }
    const op = OPS.find(o => s.startsWith(o, i))
    // `{` and `}` group commands only as whole words: `{a,b}` and `${X}` stay words.
    const wordEnds = i + 1 >= s.length || /[\s;&|)]/.test(s[i + 1]!)
    if ((op === '{' || op === '}') && (inWord || !wordEnds)) {
      word += c
      inWord = true
      i++
      continue
    }
    if (op) {
      if (inWord || words.length > 0) wantsMore = false
      endSegment(op === '&')
      if (op === '(' || op === '$(') openScope(false)
      else if (op === ')') {
        if (!stack.at(-1)?.tick) closeScope()
      } else if (op === '`') {
        if (stack.at(-1)?.tick) closeScope()
        else openScope(true)
      } else if (op === '{') {
        groups.push(listFrom)
        listFrom = out.length // the group opens a list of its own; `}` gives back the outer one
      } else if (op === '}') listFrom = groups.pop() ?? listFrom
      else if (op === '&') {
        backgroundFrom(listFrom)
        listFrom = out.length
      } else if (op === ';' || (op === '\n' && !wantsMore)) listFrom = out.length
      if (op !== '\n') wantsMore = op === '&&' || op === '||' || op === '|' || op === '|&'
      i += op.length
      if (op === '\n') skipHeredocs()
      continue
    }
    word += c
    inWord = true
    i++
  }
  endSegment(false)
  return out
}

/**
 * A working directory per subshell scope. `get` walks up to the nearest scope that set one, else `start`.
 * `set(scope, undefined)` records an unknown directory, which hides the parent's.
 */
export function scopedDir(start: string | undefined): {
  get: (scope: string) => string | undefined
  set: (scope: string, dir: string | undefined) => void
} {
  const dirs = new Map<string, string | undefined>()
  return {
    get(scope) {
      for (let s = scope; ; s = s.slice(0, s.lastIndexOf('.'))) {
        if (dirs.has(s)) return dirs.get(s)
        if (s === '') return start
      }
    },
    set: (scope, dir) => void dirs.set(scope, dir),
  }
}

/**
 * Shell variables per subshell scope, the same walk as `scopedDir`. `get` finds the value in the nearest scope that set
 * the name: a variable set in a subshell does not reach its parent, and a child reads its parent's. `set(scope, name,
 * undefined)` records an unknown value, which hides the parent's.
 */
export function scopedVars(): {
  get: (scope: string, name: string) => string | undefined
  set: (scope: string, name: string, value: string | undefined) => void
} {
  const vars = new Map<string, string | undefined>()
  const key = (scope: string, name: string): string => `${scope}\0${name}`
  return {
    get(scope, name) {
      for (let s = scope; ; s = s.slice(0, s.lastIndexOf('.'))) {
        if (vars.has(key(s, name))) return vars.get(key(s, name))
        if (s === '') return undefined
      }
    },
    set: (scope, name, value) => void vars.set(key(scope, name), value),
  }
}

const REDIRECT = /^(?:\d*|&)(?:>>?|<<?<?|>&|<&|>\|)(.*)$/

/** Drops redirections (`> f`, `2>&1`, `&>f`, `<f`) and their targets. */
function dropRedirections(words: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const m = REDIRECT.exec(words[i]!)
    if (!m) {
      out.push(words[i]!)
      continue
    }
    // `>` alone takes the next word as its target; `>file` and `2>&1` carry it.
    if (m[1] === '') i++
  }
  return out
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Reserved words that open a command in a compound (`if`, `while`, `until`, `do`, `then`, `else`, `elif`) or end one
 * (`done`, `fi`, `esac`). `!` negates the pipeline that follows: `if ! git diff --quiet` runs `git diff`. `for ...; do
 * git push; done` splits into `do git push` and `done`: the reserved words are no command. `for`, `case` and `select`
 * are not in the set: the word after them is a variable or a value, not a command.
 */
const RESERVED = new Set(['!', 'if', 'while', 'until', 'do', 'then', 'else', 'elif', 'done', 'fi', 'esac'])

/**
 * Drops the reserved words in front of a simple command. A segment that is only `done` or `fi` is left empty. It does
 * not see a reserved word behind a wrapper: `time ! git push` has `!` behind `time`. A reader calls `stripLead`.
 */
export function stripReserved(words: readonly string[]): string[] {
  let i = 0
  while (i < words.length && RESERVED.has(words[i]!)) i++
  return words.slice(i)
}

/** Strips `VAR=x`, `sudo`, `env`, `time`, `command`, `exec`, `nice`, `nohup` from the front. Returns the env it set. */
export function stripWrappers(words: readonly string[]): {
  words: string[]
  env: Record<string, string>
  nohup: boolean
} {
  const env: Record<string, string> = {}
  let nohup = false
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (ASSIGN.test(w)) {
      const eq = w.indexOf('=')
      env[w.slice(0, eq)] = w.slice(eq + 1)
      i++
      continue
    }
    if (w === 'sudo' || w === 'env' || w === 'nice') {
      i++
      // Their own flags. `-u user`, `-n 10` take a value.
      while (i < words.length && words[i]!.startsWith('-')) {
        const f = words[i]!
        i += f === '-u' || f === '-g' || f === '-n' || f === '-C' ? 2 : 1
      }
      continue
    }
    if (w === 'time' || w === 'command' || w === 'exec' || w === 'builtin') {
      i++
      continue
    }
    if (w === 'nohup') {
      nohup = true
      i++
      continue
    }
    break
  }
  return { words: words.slice(i), env, nohup }
}

/**
 * Strips the reserved words and the wrappers in front of a simple command, in any order. `time` is a reserved word that
 * comes before `!`, and `!` comes before `time`: `time ! git push`, `! time git push` and `if time ! git push` are all
 * valid shell. Each round drops the reserved words, then the wrappers, until nothing more goes. The env of every round
 * adds up: a later `VAR=x` wins. A program wrapper such as `sudo` before `!` is no valid shell: it reads the same way.
 */
export function stripLead(words: readonly string[]): ReturnType<typeof stripWrappers> {
  const env: Record<string, string> = {}
  let nohup = false
  let rest = words
  for (;;) {
    const got = stripWrappers(stripReserved(rest))
    Object.assign(env, got.env)
    nohup ||= got.nohup
    if (got.words.length === rest.length) return { words: got.words, env, nohup }
    rest = got.words
  }
}

/**
 * Joins `p` onto `cwd` and folds `.` and `..` the way a shell does. A relative path with no cwd stays relative.
 * A `~/` path stays in `~/` form. `..` at `/` or at `~` stays there.
 */
export function resolvePath(cwd: string | undefined, p: string): string {
  const abs = p.startsWith('/') || p.startsWith('~') || !cwd ? p : `${cwd}/${p}`
  const lead = abs.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      const top = parts.at(-1)
      if (top !== undefined && top !== '..' && !(top === '~' && parts.length === 1 && !lead)) parts.pop()
      else if (!lead && top !== '~') parts.push(part)
    } else parts.push(part)
  }
  return lead + parts.join('/')
}
