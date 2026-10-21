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
   * too, and so does each part of a pipeline, so their segments get a child scope of their own (see `splitShell`).
   */
  scope: string
}

// A compound command spans several segments: `for ...; do ...; done`. `COMPOUND_LEAD` are the reserved words that can
// stand in front of the opener (`do for`, `then if`, `else if`, `elif for`). `time` and its options (`time -p for ...`)
// can too. `COMPOUND_COND` open a compound and then take a command as their condition, so that command can open one too:
// `if for i in 1; do :; done; then ...` opens an `if` and a `for` in one segment.
const COMPOUND_OPEN = new Set(['for', 'while', 'until', 'if', 'case', 'select'])
const COMPOUND_COND = new Set(['while', 'until', 'if'])
const COMPOUND_CLOSE = new Set(['done', 'fi', 'esac'])
const COMPOUND_LEAD = new Set(['!', 'do', 'then', 'else', 'elif'])

/**
 * What `splitShell` knows of a word besides its text. `head`: how many of its first characters were typed, not inside
 * quotes and not after a backslash. `whole`: it holds no quote and no escape at all, so a quote of no length (`esac''`)
 * counts too. A reserved word is one only when it is `whole`: `'case'` and `\if` are commands.
 */
type Typed = { head: number; whole: boolean }

/**
 * The compounds that a segment opens, in order, and the index of the word of the last one. The scan starts at the first
 * word and goes past the reserved words and `time [-p]` up to the command. A quoted or escaped word is no reserved word.
 */
function compoundLead(words: readonly string[], typed: readonly Typed[]): { opens: string[]; at: number } {
  const opens: string[] = []
  let at = -1
  let afterTime = false
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    const kw = typed[k]?.whole === true ? w : ''
    if (COMPOUND_LEAD.has(kw)) afterTime = false
    else if (kw === 'time') afterTime = true
    else if (afterTime && w.startsWith('-')) continue
    else if (COMPOUND_COND.has(kw)) {
      opens.push(kw)
      at = k
      afterTime = false
    } else {
      if (COMPOUND_OPEN.has(kw)) {
        opens.push(kw)
        at = k
      }
      break
    }
  }
  return { opens, at }
}

// `;;`, `;&` and `;;&` end an arm of a `case`. Outside a `case` they read like `;`.
const OPS = ['&&', '||', '|&', ';;&', ';;', ';&', ';', '|', '&', '\n', '(', ')', '`', '$(', '{', '}'] as const

/** Where the splitter stands in the lists around a point: a scope, a group or a compound saves and gives back one. */
type Place = {
  /** The first segment of the and-or list that the next `&`, `;` or newline ends. */
  list: number
  /** The first segment of the pipeline part that is open now. */
  part: number
  /** A `|` or `|&` came, so the part from `part` on belongs to a pipeline. */
  piped: boolean
}

/**
 * Splits `command` into simple commands on `;`, `&&`, `||`, `|`, `&`, newlines, subshells and groups.
 * A list that ends with `&` (`cd x && npm start &`, `{ cd x; } &`, `for ...; do cd x; done &`) runs in a background
 * subshell. Its segments move to a child scope, so a `cd` in it does not reach the segments after the `&` (issue #141).
 * Each part of a pipeline (`cd x | cat`, `cat | cd x`) runs in a subshell too, the last part as well (no `lastpipe`).
 * Its segments move to a child scope of their own, so a `cd` in a part does not reach the segments after the pipeline
 * (issue #147). The `)` that ends a `case` pattern is no end of a subshell (issue #148).
 * The words of a `case` pattern are no command (issue #163): they stand in no segment and open or close no compound.
 * Only a `>` or `<` that was typed (no quote, no backslash) is a redirection (issue #162).
 */
export function splitShell(command: string): Segment[] {
  const out: Segment[] = []
  let words: string[] = []
  // For each word, how many of its first characters were typed: not inside quotes, not after a backslash. It ends at the
  // first quote or escape of the word. `dropRedirections` reads the redirection from that typed head only.
  let heads: Typed[] = []
  let word = ''
  let typedHead = 0
  let headOpen = true
  let inWord = false
  const heredocs: { tag: string; strip: boolean }[] = []
  let i = 0
  const s = command
  // Open subshells, innermost last. The segment ends before a scope opens or closes, so it keeps the scope it ran in.
  // `saved` is the `Place` of the scope that opened it. `compounds` is how many compounds were open then.
  const stack: { id: string; tick: boolean; saved: Place; compounds: number }[] = []
  let scopes = 0
  const scope = () => stack.at(-1)?.id ?? ''
  // The first segment of the and-or list that the next `&`, `;` or newline ends. `&&` and `||` keep it, and a newline
  // right after `&&`, `||` or `|` keeps it too (`wantsMore`). A group saves the list it sits in and opens one of its own:
  // `}` gives the outer list back, so `{ a; } && b &` stays one list. A `for`, `while`, `until`, `if`, `case` or `select`
  // does the same in `compounds`: its `;` inside reset the list, so `done`, `fi` or `esac` gives back the list that
  // holds the whole compound, and the `&` after it backgrounds the loop as a unit.
  let listFrom = 0
  // The first segment of the pipeline part that is open now, and whether a `|` or `|&` made it part of a pipeline. A
  // `|` closes the part before it, and the end of the pipeline closes the last part. A part is a whole command: a group,
  // a compound or a subshell with all its segments. So a scope, a group and a compound save this with the list, and the
  // opener of a compound is the first segment of the part that its head (`if cd x | cat; then`) opens.
  let partFrom = 0
  let piped = false
  const groups: Place[] = []
  // `isCase`: the compound is a `case`. Its `arm` says where the reader is in it: `head` is the subject (`case $(x)`, before
  // the `in`), `pattern` the pattern list of an arm (`in`, or `;;`, up to the `)`), `arm` the commands after the `)`. The
  // words of a pattern are no command, and the `)` that ends one is no end of a subshell. `fresh`: no word of this pattern
  // list yet. `paren`: it began with a `(`. An `esac` that comes first in a pattern list, with no `(` before it, ends the
  // case: bash reads `case x in esac` as an empty case, and `esac)` there is a syntax error.
  const compounds: (Place & { isCase: boolean; arm: 'head' | 'pattern' | 'arm'; fresh: boolean; paren: boolean })[] = []
  const here = (): Place => ({ list: listFrom, part: partFrom, piped })
  const back = (p: Place) => {
    listFrom = p.list
    partFrom = p.part
    piped = p.piped
  }
  // The last operator was `&&`, `||`, `|` or `|&` and no word has come after it: the list goes on after a newline.
  let wantsMore = false
  // Where the last `>` or `<` that was typed (no quote, no backslash) stands. `>|` and the `&` of `>&` and `<&` belong to a
  // redirection only after such a character: after a quoted or escaped one, the `|` is a pipe and the `&` a background.
  let typedRedir = -2
  // A scope opens a list and a pipeline part of its own. Its close gives back the place it sat in.
  const openScope = (tick: boolean) => {
    stack.push({ id: `${scope()}.${++scopes}`, tick, saved: here(), compounds: compounds.length })
    listFrom = partFrom = out.length
    piped = false
  }
  const closeScope = () => {
    const top = stack.pop()
    if (top) back(top.saved)
  }
  // The `case` that the reader is in right now: the innermost open compound, when it is a `case` that opened inside the
  // innermost scope. A subshell, a `$(` or a backtick in an arm opens a scope after the `case`, so inside it there is none:
  // its `)` closes that scope, and a pattern word there is a command.
  const theCase = () => {
    const c = compounds.at(-1)
    return c?.isCase === true && compounds.length > (stack.at(-1)?.compounds ?? 0) ? c : undefined
  }
  const inPattern = () => theCase()?.arm === 'pattern'
  const startPattern = (c: NonNullable<ReturnType<typeof theCase>>) => {
    c.arm = 'pattern'
    c.fresh = true
    c.paren = false
  }
  // The `in` of a header that sits in one segment: `case x in`, behind the reserved words and `time [-p]`. A header split by
  // a substitution (`case $(x) in`, `case x` newline `in`) ends in `endWord` instead, at its lone `in`.
  const caseHeaderEnds = () => {
    // The `case` stands two words before the `in`. This O(1) check keeps a long run of lead words that all continue the
    // scan (`if if if ... in in in`) from costing a full scan at each `in`.
    if (words.at(-1) !== 'in' || words.at(-3) !== 'case') return false
    const lead = compoundLead(words, heads)
    return lead.opens.at(-1) === 'case' && words.length === lead.at + 3
  }
  // The segments from `from` run in a subshell of their own: a background list or a pipeline part. They move to a child
  // of the current scope. Every segment of them sits in that scope or in a scope under it. A part that holds only
  // subshells has scopes of its own already, and a wrapper scope with no segment changes nothing. So it moves nothing:
  // else each `)` of a deep `( a | ( b | ... ) )` would relabel every inner segment again.
  const moveToChild = (from: number) => {
    const parent = scope()
    const moving = out.slice(from)
    if (!moving.some(seg => seg.scope === parent)) return
    const child = `${parent}.${++scopes}`
    for (const seg of moving) {
      if (seg.scope === parent || seg.scope.startsWith(`${parent}.`)) seg.scope = child + seg.scope.slice(parent.length)
    }
  }
  // The pipeline ends: its last part runs in a subshell too, and the next part starts after the segments so far.
  const endPipe = () => {
    if (piped) moveToChild(partFrom)
    piped = false
    partFrom = out.length
  }

  const endWord = () => {
    if (inWord) {
      const c = theCase()
      // A keyword is a keyword only as typed: `'esac'`, `"esac"`, `\esac` and `esac''` are patterns, and the cleaned word
      // cannot tell. `headOpen` is still true when the word held no quote and no escape.
      const plain = headOpen
      if (c?.arm === 'head' && word === 'in' && plain) {
        // The `in` of `case $(x) in` or `case x` newline `in` ends the header. It is no command, and the words before it
        // in the segment are the rest of the subject.
        startPattern(c)
        words = []
        heads = []
      } else {
        if (c?.arm === 'pattern') {
          if (c.fresh && !c.paren && word === 'esac' && plain) c.arm = 'arm' // the case ends: the segment `esac` closes it
          c.fresh = false
        }
        words.push(word)
        heads.push({ head: typedHead, whole: plain })
      }
    }
    word = ''
    inWord = false
    typedHead = 0
    headOpen = true
  }
  // A typed character: no quote, no backslash. It stays in the typed head of the word as long as every character before it
  // in the word was typed too.
  const typed = (ch: string) => {
    word += ch
    inWord = true
    if (headOpen) typedHead = word.length
  }
  const endSegment = (bg: boolean) => {
    endWord()
    if (inPattern()) {
      // The words of a pattern are no command: they open or close no compound, and `cd)` moves no folder.
      words = []
      heads = []
      return
    }
    const { words: clean, heads: cleanHeads } = dropRedirections(words, heads)
    if (clean.length > 0) {
      out.push({ words: clean.map(unmarkDollars), marked: clean, bg, scope: scope() })
      const lead = compoundLead(clean, cleanHeads)
      if (lead.opens.length > 0) {
        // `if for i in 1; do ...; done; then` opens an `if` and a `for` in one segment: each gets its own level.
        for (const kind of lead.opens) {
          compounds.push({ ...here(), isCase: kind === 'case', arm: 'head', fresh: false, paren: false })
          partFrom = out.length - 1
          piped = false
        }
        const top = compounds.at(-1)!
        if (top.isCase && clean[lead.at + 2] === 'in') startPattern(top)
      } else if (COMPOUND_CLOSE.has(clean[0]!)) {
        // `esac` can follow a compound with no `;;` (`a | { b; } esac`), and `fi esac` or `done esac` close two compounds.
        // Each close ends the pipeline that is open in it, then gives back the place from before its compound.
        for (let k = 0; COMPOUND_CLOSE.has(clean[k] ?? ''); k++) {
          endPipe()
          const open = compounds.pop()
          if (open) back(open)
        }
      }
    }
    words = []
    heads = []
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
      headOpen = false
      i += 2
      continue
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      word += literalDollars(s.slice(i + 1, end === -1 ? s.length : end))
      inWord = true
      headOpen = false
      i = end === -1 ? s.length : end + 1
      continue
    }
    if (c === '"') {
      headOpen = false
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
      // The `in` of `case x in` ends the header: what comes after it is a pattern, not a part of the segment.
      if (caseHeaderEnds()) endSegment(false)
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
    // `&` inside a redirection (`2>&1`, `>&2`, `&>file`, `&>>file`) is not an operator. The `>` or `<` just before must be
    // typed: after a quoted or escaped one (`'>'&`, `\>&`) the `&` runs the command in the background.
    if (c === '&' && (typedRedir === i - 1 || s[i + 1] === '>')) {
      typed(c)
      i++
      continue
    }
    // `>|` is a redirection that overrides `noclobber`, not a pipe. The `>` just before must be typed: a quoted or escaped
    // `>` (`\>|`) is a word, so the `|` after it is a pipe.
    if (c === '|' && s[i - 1] === '>' && typedRedir === i - 1) {
      typed(c)
      i++
      continue
    }
    const op = OPS.find(o => s.startsWith(o, i))
    // `{` and `}` group commands only as whole words: `{a,b}` and `${X}` stay words. The closing backtick of a `\`...\``
    // ends a word too (`{ a; }\``), and an opening one does not (`}\`x\`` is the word `}x`). A pattern word is no group.
    const wordEnds =
      i + 1 >= s.length || /[\s;&|)]/.test(s[i + 1]!) || (s[i + 1] === '`' && stack.at(-1)?.tick === true)
    if ((op === '{' || op === '}') && (inWord || !wordEnds || inPattern())) {
      typed(c)
      i++
      continue
    }
    if (op) {
      const pending = inWord || words.length > 0
      // The word `in` or `esac` can change where the reader is in a `case`, so it ends before the operator is read.
      endWord()
      const pc = theCase()
      if (pc?.arm === 'pattern') {
        // In a pattern list only `)` ends the pattern, and `|` separates the alternatives: it is no pipe. Any other operator
        // is read as usual, and each one drops the pattern words.
        if (op === '|' || op === ')') {
          endSegment(false) // drops the words of the pattern
          if (op === ')') {
            // The arm after the pattern is a list of its own.
            endPipe()
            listFrom = out.length
            pc.arm = 'arm'
          }
          i++
          continue
        }
      }
      if (pending) wantsMore = false
      endSegment(op === '&')
      if (op === '(') {
        // A `(` in front of the first word of a pattern list is part of the pattern, no subshell. The segment above can have
        // ended the header just now (`case x in(x)`), so the case is read again.
        const c = theCase()
        if (c?.arm === 'pattern' && c.fresh && !c.paren) c.paren = true
        else openScope(false)
      } else if (op === '$(') {
        openScope(false)
      } else if (op === ')') {
        endPipe()
        // A `)` in a `case` closes no scope: the pattern ends there. The arm after it is a list of its own.
        if (theCase()) listFrom = out.length
        else if (!stack.at(-1)?.tick) closeScope()
      } else if (op === '`') {
        if (stack.at(-1)?.tick) {
          endPipe()
          closeScope()
        } else openScope(true)
      } else if (op === '{') {
        groups.push(here())
        listFrom = partFrom = out.length // the group opens a list and a part of its own; `}` gives back the outer ones
        piped = false
      } else if (op === '}') {
        endPipe()
        const outer = groups.pop()
        if (outer) back(outer)
      } else if (op === '|' || op === '|&') {
        moveToChild(partFrom) // the part before the `|` runs in a subshell
        partFrom = out.length
        piped = true
      } else if (op === '&') {
        endPipe()
        moveToChild(listFrom)
        listFrom = out.length
      } else if (op === ';' || op === ';;' || op === ';&' || op === ';;&' || (op === '\n' && !wantsMore)) {
        endPipe()
        listFrom = out.length
        // The end of an arm: the next words are a pattern list.
        const arm = theCase()
        if (op.length > 1 && arm?.arm === 'arm') startPattern(arm)
      } else if (op === '&&' || op === '||') endPipe()
      if (op !== '\n') wantsMore = op === '&&' || op === '||' || op === '|' || op === '|&'
      i += op.length
      if (op === '\n') skipHeredocs()
      continue
    }
    if (c === '>' || c === '<') typedRedir = i
    typed(c)
    i++
  }
  endSegment(false)
  endPipe()
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

const REDIRECT = /^(?:\d*|&)(?:>\||>>?|<<?<?|>&|<&)(.*)$/

/**
 * Drops redirections (`> f`, `2>&1`, `&>f`, `<f`) and their targets. `typed[i].head` is how many of the first characters
 * of `words[i]` were typed. Only that head can hold the redirection: a quoted or escaped `>` is a word (`\>`, `'>'`,
 * `2\>&1`), and so is the word after it (issue #162). Returns the words that stay, with their `Typed`.
 */
function dropRedirections(words: readonly string[], typed: readonly Typed[]): { words: string[]; heads: Typed[] } {
  const out: { words: string[]; heads: Typed[] } = { words: [], heads: [] }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const t = typed[i]!
    const m = REDIRECT.exec(word.slice(0, t.head))
    if (!m) {
      out.words.push(word)
      out.heads.push(t)
      continue
    }
    // `>` alone takes the next word as its target; `>file` and `2>&1` carry it. So does a target that was quoted or
    // escaped, right behind the typed `>` (`>\>`, `>'f g'`, and an empty quote: `>''`).
    if (m[1] === '' && t.whole) i++
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
