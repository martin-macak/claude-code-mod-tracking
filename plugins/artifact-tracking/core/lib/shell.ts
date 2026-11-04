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
  /** Words with quotes and escapes removed. Redirections are dropped: `stdoutRedirected` says if one sent the output away. */
  words: string[]
  /**
   * The same words, with each `$` that quotes or an escape made literal replaced by `LITERAL_DOLLAR`. Quotes and escapes
   * are gone from `words`, so only this array says which `$NAME` the shell expands (bare, or in double quotes) and which
   * it passes on as typed (`'$NAME'`, `\$NAME`). Same length and order as `words`.
   */
  marked: string[]
  /**
   * For each word, `Typed.whole`: it holds no quote and no escape at all. A reserved word is one only then, so `stripLead`
   * and `stripReserved` read this to keep `'done'` as a command (issue #194). Same length and order as `words`.
   */
  whole: boolean[]
  /**
   * For each word, `Typed.redir`: a redirection stood right before it in the text, and `words` dropped that redirection.
   * Bash reads an option of `time` only while nothing stands between it and `time` or the option before it, so a word
   * behind a redirection is no option: `time >/dev/null -p printf ok` runs a command named `-p` (issue #227). Same length
   * and order as `words`.
   */
  redir: boolean[]
  /** The segment ended with a single `&`: the shell runs it in the background. */
  bg: boolean
  /**
   * A single `&` ended a group, a subshell, an arithmetic command or a substitution right before this segment (`{ a; } & b`,
   * `( a ) & b`, `x=$(a) & b`, `sleep $(a) & b`), or it ended a bare redirection (`> f & b`), or a process substitution
   * closed there, with or without a `&` (`exec 3< <(a); b`, `cat <(a) > f; b`): the shell sets `$!` for it too (issue #263).
   * `}` and `)` make no segment, so that `&` has none to say `bg` on.
   * The flag tells a reader that this `&` set `$!` to something that is not the job before it (issue #231).
   * What `$!` names depends on the command. For a group (`{ a; } &`, `{ true; sleep 3; } &`: a group is never run in
   * place), a subshell whose last command is a builtin or a compound (`( sleep 3; : ) &`, `( : ) &`), `(( ))`, and a command that is only assignments
   * or a builtin (`x=$(a) &`, `: $(a) &`) it names the shell that runs the list. For a subshell whose last command is an
   * external simple command (`( sleep 3 ) &`, `( true; sleep 3 ) &`, also with a redirection) bash runs that command in
   * place, and an external command that ends in a substitution or a process substitution (`sleep $(a) &`, `cat <(a) &`) is a
   * process: `$!` names that command. The flag is set all the same, and the parser makes no row for it (a limit). A loop, an
   * `if` or a `case` needs no flag: its closing word is a segment with `bg`. The flag stays in the shell that read the `&`: a
   * substitution, a subshell and a part of a pipeline run in a shell of their own, so a `&` that ends a group in one of them,
   * with no segment after it there, flags nothing in the parent (`a & x=$({ :; } &); echo $!` flags no `echo`, as `$!` is still
   * the pid of `a`).
   */
  afterBgShell: boolean
  /**
   * The segment ended with a single `&`, and the list that it ends holds an `&&` or `||` before it (`a && b &`). Bash runs the
   * whole list in a subshell, so `$!` names that shell, not the last command (issue #263; bash 5.3.20). A reader gives the
   * segment no pid. A pipeline (`a | b &`) is no such list: `$!` names its last part.
   */
  bgList: boolean
  /**
   * The shell that reads the segment, for the `$!` of the parser (issue #263): the number of the innermost open `(`, `$(`,
   * backtick or process substitution scope, or of the pipeline part that holds it (issue #353), and `0` at the top level. A `&`
   * list runs in a subshell, but it sets `$!` in the shell that reads it, so `scope` is no help here. `shellUp` is the number of
   * the nearest shell around it that holds a segment by then (`0` if none), as a shell with no segment of its own changes no
   * `$!`. A number is a key that stays O(1) in a deep nest, where the text of `scope` grows.
   */
  shell: number
  shellUp: number
  /**
   * The shell whose `$!` the `&` that ends the segment sets (issue #353). It is `shell`, but for the last segment of a pipeline
   * that `&` ends (`true | sleep 3 &`): its part runs in a shell of its own, and the shell around the pipeline reads the `&`.
   */
  bgShell: number
  /**
   * The shell whose `$!` the `&` behind `afterBgShell` sets: the shell that read that `&` (issue #353). The segment that carries
   * the flag can run in another one: in `( a ) & true | echo $!` the `&` is read by the shell around the pipeline, and `true`
   * runs in a part of it. Without the flag it is `shell`.
   */
  flagShell: number
  /**
   * The segment is a whole part of a pipeline that `&` ends, and not its last part (`sleep 3 | true &`, issue #353). It runs in
   * the background too, but `$!` names the last part, so its row gets no pid. A part of more than one segment has none.
   */
  bgPart: boolean
  /** The segment runs in a part of a pipeline, the last part too (issue #353). */
  inPipe: boolean
  /**
   * The segment goes on a simple command that a substitution cut (`sleep $(a) 101`: the tail `101`, issue #353). It is no command
   * of its own: `$!` names the whole command, so the tail gets no row.
   */
  cmdTail: boolean
  /**
   * The subshell the segment runs in. `''` is the top level. `(`, `$(` and a backtick pair open a child scope
   * `${parent}.${n}`. `{ }` is the same shell, so it keeps the scope. A list that ends with `&` runs in a subshell
   * too, and so does each part of a pipeline, so their segments get a child scope of their own (see `splitShell`).
   */
  scope: string
  /**
   * Where the standard output of the segment goes (issue #231). A segment with none of the three marks below prints where
   * the shell prints. A reader asks `keepsStdout` and reads none of them itself.
   * `stdoutRedirected`: a typed redirection sends fd 1 away (`>`, `>>`, `>|`, `&>`, `&>>`, `>&word`, `1>`), on the segment
   * or on the group, subshell or compound that holds it (`{ a; } > f`, `for ...; done > f`), or after a substitution that cut
   * the command into segments (`a $(b) c > f` marks `a` and `c`), or after a bare `exec` that redirects the output in the
   * same shell (`exec > f; a` marks `a`, `( exec > f ); a` and `{ exec > f; } > g; a` do not: the redirected group gives fd 1
   * back at its end). A redirection of stderr (`2>`, `2>&1`), of the input or of another descriptor (`3>`, `{fd}>`) leaves
   * the output alone, and so does a copy of fd 1 onto itself (`>&1`, `1>&1`, `>& 1`). The commands in an output process
   * substitution (`>(...)`) write where the command around it writes, so they take its redirection too, when it stands before
   * the substitution (`a >f > >(b)` and `a >f >(b)` mark `b`, and `a $(c) >f >(b)` does). The `>` whose target is the
   * substitution is not one of those: `a > >(b)` marks `a`, and leaves `b` alone.
   */
  stdoutRedirected: boolean
  /**
   * A `|` or `|&` follows the pipeline part that holds the segment (`a | b` marks `a`, `{ a; } | b` marks `a`), so the
   * output goes to the next command. The last part of a pipeline is not marked: its output goes where the shell's goes.
   */
  stdoutPiped: boolean
  /**
   * The segment runs inside `$(...)`, backticks or an input process substitution (`<(...)`), so the shell takes its output, or
   * it goes to the pipe that the command reads. An output process substitution (`>(...)`) is none: its commands read the pipe
   * and write where the command around it writes (bash 5.3.20: `cat > >(docker run -d nginx) </dev/null; wait` prints the id).
   * Its segments carry the marks of that command, and `substituted` of the scope that holds it (`x=$(cat > >(a))` marks `a`).
   */
  substituted: boolean
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
 * counts too. A reserved word is one only when it is `whole`: `'case'` and `\if` are commands. `redir`: a redirection stood
 * right before the word, between it and the word before it (or the start of the segment). `dropRedirections` drops the
 * redirection from the words, and so does the heredoc branch of `splitShell`, so this flag is the only trace of it.
 */
type Typed = { head: number; whole: boolean; redir: boolean }

/**
 * The index after the options that bash gives `time`, from `from`, the word behind it: `-p`, then `--`, each at most
 * once. Any other word is the command, so `time -x git push` runs a command named `-x` (issue #227). An option counts
 * only when `plain(i)` says that word `i` was typed whole and that no redirection stands right before it: `time "-p"
 * printf ok`, `time \-p printf ok` and `time >/dev/null -p printf ok` run a command named `-p`. `compoundLead` and
 * `stripWrappers` both read the options of `time` here, so the two cannot drift.
 */
function skipTimeOptions(words: readonly string[], from: number, plain: (i: number) => boolean): number {
  let i = from
  if (words[i] === '-p' && plain(i)) i++
  if (words[i] === '--' && plain(i)) i++
  return i
}

/**
 * How a wrapper that runs the next command reads its own words (issue #242). `short`: the letters of the options that take
 * a value (`-s KILL`, `-sKILL`). `long`: the long options that take a value in the next word (`--signal KILL`; the glued
 * `--signal=KILL` is one word and needs no entry). `inert`: letters of an option that makes the wrapper run no command
 * (`ionice -p PID` changes a process that runs). `inertLong`: the long forms of those (`--pid`). `positional`: how many
 * words follow the options (`timeout` has its DURATION). `fork`: the option that forks on its own, in both forms
 * (`setsid -f`, `setsid --fork`). `needsCommand`: with no word left, the wrapper runs no command and stays
 * (`caffeinate -t 60` only holds the system awake).
 */
type WrapperSpec = {
  short: string
  long?: readonly string[]
  inert?: string
  inertLong?: readonly string[]
  positional?: number
  fork?: { short: string; long: string }
  needsCommand?: boolean
  /**
   * Letters and long names of the options that take no value. They count together with `short` and `long`. When set,
   * any other option is unknown and the wrapper stays (issue #336).
   */
  known?: { short: string; long: readonly string[] }
}

/**
 * The wrappers that share one option grammar. `sudo`, `env`, `nice`, `nohup`, `time`, `command`, `exec` and `builtin`
 * need rules of their own and stay in `stripWrappers`.
 */
const WRAPPER_SPECS: Readonly<Record<string, WrapperSpec>> = {
  timeout: { short: 'sk', long: ['--signal', '--kill-after'], positional: 1 },
  gtimeout: { short: 'sk', long: ['--signal', '--kill-after'], positional: 1 },
  ionice: {
    short: 'cnpPu',
    long: ['--class', '--classdata', '--pid', '--pgid', '--uid'],
    inert: 'pPu',
    inertLong: ['--pid', '--pgid', '--uid'],
  },
  stdbuf: { short: 'ioe', long: ['--input', '--output', '--error'] },
  setsid: { short: '', fork: { short: 'f', long: '--fork' } },
  caffeinate: { short: 'tw', inert: 'w', needsCommand: true },
  // `doas -C FILE` only checks the policy file: "No command is executed."
  doas: { short: 'uC', inert: 'C' },
}

/**
 * The words that name the external `time`: the usual install paths and Homebrew's `gtime`. Another path (a build in
 * `/opt/x/bin/time`) is not guessed, so the reader keeps it as the command (issue #336).
 */
const EXTERNAL_TIME_NAMES: ReadonlySet<string> = new Set([
  '/usr/bin/time',
  '/bin/time',
  '/usr/local/bin/time',
  '/opt/homebrew/bin/gtime',
  'gtime',
])

/**
 * The options of the external `time` (`/usr/bin/time`), the union of GNU and BSD. With a value: `-f FMT`, `-o FILE`.
 * Without: GNU `-a -v -q -p`, BSD `-l -h -p`. An unknown option keeps the text as it is, so the reader does not guess
 * (issue #336).
 */
const EXTERNAL_TIME: WrapperSpec = {
  short: 'fo',
  long: ['--format', '--output'],
  known: { short: 'avqplh', long: ['--append', '--verbose', '--quiet', '--portability'] },
}

/**
 * Where the command starts behind the wrapper `spec` whose words begin at `from` (the word after the name), and whether
 * it forks on its own. `at` is -1 when the wrapper runs no command (`ionice -p 1`) or, for a spec with `known`, when it has an option the spec
 * does not list: the caller then keeps the text. Options come first, `--` ends them,
 * then come the positional words. A short option may be glued to the next ones (`-dimsu`) or to its value (`-sKILL`).
 * The wrapper is an external program, so quotes and redirections do not matter: the shell removes them before it starts
 * the program (`ionice "-c3" cmd` passes `-c3`). Only the reserved word `time` reads typed flags (`skipTimeOptions`).
 */
function skipWrapperOptions(spec: WrapperSpec, words: readonly string[], from: number): { at: number; fork: boolean } {
  let i = from
  let fork = false
  let inert = false
  for (; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') {
      i++
      break
    }
    if (w.startsWith('--')) {
      const name = w.split('=', 1)[0]!
      if (spec.known && !spec.known.long.includes(name) && !spec.long?.includes(name)) return { at: -1, fork }
      if (w === spec.fork?.long) fork = true
      // `--pid=123` is inert too: the name is the part before the `=`.
      if (spec.inertLong?.includes(name)) inert = true
      if (spec.long?.includes(w)) i++
      continue
    }
    if (!w.startsWith('-') || w === '-') break
    for (let k = 1; k < w.length; k++) {
      const c = w[k]!
      if (spec.known && !spec.known.short.includes(c) && !spec.short.includes(c)) return { at: -1, fork }
      if (c === spec.fork?.short) fork = true
      if (spec.short.includes(c)) {
        if (spec.inert?.includes(c)) inert = true
        if (k === w.length - 1) i++
        break
      }
    }
  }
  if (inert) return { at: -1, fork }
  const at = Math.min(i + (spec.positional ?? 0), words.length)
  if (spec.needsCommand && at >= words.length) return { at: -1, fork }
  return { at, fork }
}

/**
 * The compounds that a segment opens, in order, and the index of the word of the last one. The scan starts at the first
 * word and goes past the reserved words and `time [-p]` up to the command. A quoted or escaped word is no reserved word.
 */
function compoundLead(words: readonly string[], typed: readonly Typed[]): { opens: string[]; at: number } {
  const opens: string[] = []
  let at = -1
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    const kw = typed[k]?.whole === true ? w : ''
    if (COMPOUND_LEAD.has(kw)) continue
    if (kw === 'time') {
      k = skipTimeOptions(words, k + 1, i => typed[i]?.whole === true && typed[i]?.redir === false) - 1
      continue
    }
    if (COMPOUND_COND.has(kw)) {
      opens.push(kw)
      at = k
      continue
    }
    if (COMPOUND_OPEN.has(kw)) {
      opens.push(kw)
      at = k
    }
    break
  }
  return { opens, at }
}

/**
 * The word at `k` is a `done`, `fi` or `esac` that closes a compound. Like a reserved word in `compoundLead`, it counts
 * only as typed: `'done'`, `\fi` and `esac''` are commands of that name, and the cleaned text cannot tell (issue #184).
 */
function closesAt(words: readonly string[], typed: readonly Typed[], k: number): boolean {
  return typed[k]?.whole === true && COMPOUND_CLOSE.has(words[k] ?? '')
}

/**
 * A subshell scope of `splitShell` while it reads (issue #380). `n`: its number, the last part of its id. `up`: the scope it
 * sits in, `undefined` for the top level. `from`: the count of segments when it opened. `kids`: the scopes right under it, and
 * `direct`: the index of each segment that runs in it, both in segment order. The kids hold ranges of segments that do not
 * overlap. A move to a child scope changes `up` of the scopes right under it and leaves the deeper ones alone, so the id of a
 * segment (`Segment.scope`) is written only at the end.
 */
type ScopeNode = {
  n: number
  up: ScopeNode | undefined
  from: number
  /** The count of segments when it closed, or when a move made it. `Infinity` while it is open. */
  end: number
  kids: ScopeNode[]
  direct: number[]
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
  /** The parts of the pipeline so far that are one segment each: the index of that segment (`Segment.bgPart`). */
  solo: number[]
}

/**
 * Splits `command` into simple commands on `;`, `&&`, `||`, `|`, `&`, newlines, subshells and groups.
 * A list that ends with `&` (`cd x && npm start &`, `{ cd x; } &`, `for ...; do cd x; done &`) runs in a background
 * subshell. Its segments move to a child scope, so a `cd` in it does not reach the segments after the `&` (issue #141).
 * Each part of a pipeline (`cd x | cat`, `cat | cd x`) runs in a subshell too, the last part as well (no `lastpipe`).
 * Its segments move to a child scope of their own, so a `cd` in a part does not reach the segments after the pipeline
 * (issue #147). The `)` that ends a `case` pattern is no end of a subshell (issue #148).
 * The words of a `case` pattern are no command (issue #163): they stand in no segment and open or close no compound.
 * Only a `>` or `<` that was typed (no quote, no backslash) is a redirection (issue #162). It ends the word in front of it,
 * as in bash: `nginx>f` is the word `nginx` and the redirection `>f`, and `}>f` and `done>f` close a group or a loop
 * (issue #231). A file descriptor in front (`2>f`, `{fd}>f`, `&>f`), arithmetic text and an open `${ }` keep the character.
 * A here-string (`<<<`) is one too, with one word: it is no heredoc, so the next line is a command (issue #182). So are
 * `<>` and `n<>` (issue #183).
 * Only a `done`, `fi` or `esac` that was typed whole closes a compound: `'done' y` is a command (issue #184).
 * A heredoc tag is the next word with its quotes and backslashes removed, so `<<\EOF` hides its body as `<<'EOF'` does. A
 * file descriptor right before `<<` (`3<<EOF`, `{fd}<<EOF`) is part of the redirection, and so is `{name}` before `<`, `>`
 * or `<>` (issue #194). A `<<` inside `$(( ))` or `(( ))` is a shift, not a heredoc: the scope of that text says so.
 * Each segment says where its standard output goes (issue #231): `stdoutRedirected`, `stdoutPiped` and `substituted`. A group,
 * subshell, loop or `case` that is redirected or piped marks every segment in it. A `<(...)` is substituted (it writes to the
 * pipe that the command reads). A `>(...)` is not: it writes where the command around it writes, so it has the marks of that
 * command, and the redirection of its output that stands before the substitution (`Segment.stdoutRedirected`). The marks are
 * ranges over the segments, summed once at the end, so a redirection on each of a deep nest of groups costs O(n), not
 * O(n^2). A bare `exec` that redirects the output marks the later segments of its shell and of the subshells under it, up to
 * the end of the group, loop or `if` that redirects the output around it (`{ exec > f; } > g; a` marks no `a`,
 * `{ exec > f; }; a` does).
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
  // How many `${` of the word are still open. A `>` or `<` in one is text (`${X:-a>b}`).
  let paramOpen = 0
  const heredocs: { tag: string; strip: boolean }[] = []
  let i = 0
  const s = command
  // Open subshells, innermost last. The segment ends before a scope opens or closes, so it keeps the scope it ran in.
  // `saved` is the `Place` of the scope that opened it. `compounds` is how many compounds were open then. `arith`: the text
  // in it is an arithmetic expression (`$(( ))`, `(( ))`), where `<<` is a shift (issue #194). `sub`: the shell takes the
  // output of the commands in it: a `$(`, a backtick or a `<(` opened it, or one of its parents did (`Segment.substituted`).
  // `moved`: the output of the command around a `>(` went away before the substitution (`a >f > >(b)`), so the commands in it
  // write there too, and so do the scopes in it (`Segment.stdoutRedirected`). `outerHead`, `outerWord`, `outerOut`: the `cmdHead`, `cmdWord` and the
  // `cmdOut` of the simple command around it, back at the close (`a $(b) c`).
  // `bgFlagPending`: the `bgFlag` of the shell around it, back at the close. `from`: the index of the first segment in it.
  const stack: {
    node: ScopeNode
    tick: boolean
    saved: Place
    andOr: number
    compounds: number
    arith: boolean
    sub: boolean
    moved: boolean
    outerHead: number
    outerWord: boolean
    outerOut: boolean
    bgFlagPending: { shell: number; at: number } | undefined
    from: number
    n: number
    /** A process substitution (`<(`, `>(`): the shell that holds it gets a `$!` from it, whatever it holds. */
    proc: boolean
    /** The number of the nearest shell around it that held a segment by the time it opened (`holds`), else `0`. */
    anc: number
  }[] = []
  let scopes = 0
  // The scope of each segment, as a node of the tree (`ScopeNode`). `Segment.scope` is its path, written once at the end.
  const root: ScopeNode = { n: 0, up: undefined, from: 0, end: Infinity, kids: [], direct: [] }
  const scopeOfSegment: ScopeNode[] = []
  const scopeNode = () => stack.at(-1)?.node ?? root
  // The numbers of the pipeline parts (`partShell`) count down from -1, so they never meet the number of a scope.
  let partShells = 0
  // The first segment of the and-or list that the next `&`, `;` or newline ends. `&&` and `||` keep it, and a newline
  // right after `&&`, `||` or `|` keeps it too (`wantsMore`). A group saves the list it sits in and opens one of its own:
  // `}` gives the outer list back, so `{ a; } && b &` stays one list. A `for`, `while`, `until`, `if`, `case` or `select`
  // does the same in `compounds`: its `;` inside reset the list, so `done`, `fi` or `esac` gives back the list that
  // holds the whole compound, and the `&` after it backgrounds the loop as a unit.
  let listFrom = 0
  // `out.length` at the last `&&` or `||`. The list that a `&` ends holds one when this is not before `listFrom`.
  let andOrAt = -1
  // The first segment of the pipeline part that is open now, and whether a `|` or `|&` made it part of a pipeline. A
  // `|` closes the part before it, and the end of the pipeline closes the last part. A part is a whole command: a group,
  // a compound or a subshell with all its segments. So a scope, a group and a compound save this with the list, and the
  // opener of a compound is the first segment of the part that its head (`if cd x | cat; then`) opens.
  let partFrom = 0
  let piped = false
  let solo: number[] = []
  // `from`: the index of the first segment in the group.
  const groups: (Place & { from: number; andOr: number })[] = []
  // `isCase`: the compound is a `case`. Its `arm` says where the reader is in it: `head` is the subject (`case $(x)`, before
  // the `in`), `pattern` the pattern list of an arm (`in`, or `;;`, up to the `)`), `arm` the commands after the `)`. The
  // words of a pattern are no command, and the `)` that ends one is no end of a subshell. `fresh`: no word of this pattern
  // list yet. `paren`: it began with a `(`. An `esac` that comes first in a pattern list, with no `(` before it, ends the
  // case: bash reads `case x in esac` as an empty case, and `esac)` there is a syntax error. `from`: the index of the
  // segment of its opener, the first of the compound.
  const compounds: (Place & {
    isCase: boolean
    arm: 'head' | 'pattern' | 'arm'
    fresh: boolean
    paren: boolean
    from: number
  })[] = []
  // Where the output of the segments goes (`Segment.stdoutPiped`, `Segment.stdoutRedirected`). A pipe or a redirection of a
  // group covers a range of segments: `cover` puts +1 at its start and -1 at its end, and the sums at the end of the scan
  // say which segments are covered. Marking each segment of the range would cost O(n) for each of a nest of n groups.
  const pipeRuns: number[] = []
  const redirRuns: number[] = []
  // The parts of pipelines, the last ones too (`Segment.inPipe`): the same ranges.
  const pipeAll: number[] = []
  // For each shell number, the segments that write its `$!` (their `shell` or `bgShell` is it), and the segments whose `shellUp`
  // is it, in segment order. `partShell` takes them from the end. A shell holds a segment while its list is not empty.
  const writers = new Map<number, number[]>()
  const ups = new Map<number, number[]>()
  const push = (lists: Map<number, number[]>, key: number, at: number) => {
    const list = lists.get(key)
    if (list) list.push(at)
    else lists.set(key, [at])
  }
  const holds = (n: number) => (writers.get(n)?.length ?? 0) > 0
  // The index of each segment that is a bare `exec` with a redirection of the output (`exec > f`), in segment order. It moves
  // the output of its shell, so the segments after it in that shell, and in the subshells under it, are marked at the end.
  const execs: number[] = []
  const cover = (runs: number[], from: number, to: number) => {
    if (from >= to) return
    runs[from] = (runs[from] ?? 0) + 1
    runs[to] = (runs[to] ?? 0) - 1
  }
  // The group, subshell or compound that holds the segments from `from` on redirects the output, and closes now. It saves fd 1
  // and gives it back at its end (`{ exec > f; } > g; a` prints `a`, in bash), so an exec inside it moves the output only up to
  // here. The range marks those segments already, so the exec has nothing left to mark and is dropped. The execs inside the
  // range are the last ones of the list, so each exec is dropped once: O(1) amortized, also on a nest of redirected groups.
  const redirected = (from: number) => {
    cover(redirRuns, from, out.length)
    while (execs.length > 0 && execs[execs.length - 1]! >= from) execs.pop()
  }
  // The first segment of the group, subshell or backtick that closed just now, while only redirections have come after
  // it: `{ a; } > f` has the words `> f` after the `}`, and they make no segment. -1: no group closed right before.
  let closedFrom = -1
  // A `&` with no word came right behind a close (`{ a; } &`, `x=$(a) &`, `sleep $(a) &`): the next segment carries
  // `Segment.afterBgShell`. The `&` set `$!` in the shell that read it, so the flag stays in that shell. A substitution, a
  // backtick pair, a subshell and a part of a pipeline run in a shell of their own, and a `&` inside them leaves the `$!` of the
  // parent alone (`x=$({ :; } &); echo $!` prints the job before). So the flag that is still waiting for a segment when such a
  // shell ends dies with it: a scope gives back the flag that its parent had (`closeScope`), and a pipeline part drops it
  // (`endPipe`, the `|` branch). A group is the shell of its parent, and keeps it. `shell`: the shell that read the `&`, whose
  // `$!` it sets (`Segment.flagShell`). `at`: the count of segments then, so `partShell` can tell a `&` before a part of a
  // pipeline from one inside it.
  let bgFlag: { shell: number; at: number } | undefined
  // `flagAt[k]`: the `at` of the flag of segment `k`.
  const flagAt: number[] = []
  // A substitution splits a simple command into segments: `docker run -d $(a) nginx > f` has the segments `docker run -d`,
  // `a` (inside) and `nginx > f`, and the redirection belongs to all of the command. `cmdHead` is the index of the first
  // segment of the simple command that a substitution has split, in the scope that is open now. -1: none. An operator that
  // ends the command resets it. A substitution gives back the one of the scope around it at its close.
  let cmdHead = -1
  // A word of the command itself (no assignment `A=`) stood in the simple command so far. `FOO=$(a) sleep 101`: the segment
  // after the substitution is the command, no tail. Resets and returns with `cmdHead`.
  let cmdWord = false
  // A typed redirection of fd 1 stood in the simple command so far, in one of its segments (`a >f $(b) >(c)`). It follows
  // `cmdHead`: an operator that ends the command resets it, and a substitution gives back the one of the command around it.
  // `>(c)` reads it for the commands in it (`openScope`, `moved`), as bash applies the redirections in front of it first.
  let cmdOut = false
  // What `endSegment` saw in the segment that it closed last: a redirection of fd 1 (`segOut`), and the same without the one
  // that has no target yet (`segPlaced`). `a > >(b)` ends the segment `a >` right before `(`, and its `>` takes the substitution
  // as its target, so the commands in it must not read it as a redirection that came before them.
  let segOut = false
  let segPlaced = false
  const here = (): Place => ({ list: listFrom, part: partFrom, piped, solo })
  const back = (p: Place) => {
    listFrom = p.list
    partFrom = p.part
    piped = p.piped
    solo = p.solo
  }
  // The last operator was `&&`, `||`, `|` or `|&` and no word has come after it: the list goes on after a newline.
  let wantsMore = false
  // Where the last `>` or `<` that was typed (no quote, no backslash) stands. `>|` and the `&` of `>&` and `<&` belong to a
  // redirection only after such a character: after a quoted or escaped one, the `|` is a pipe and the `&` a background.
  let typedRedir = -2
  // A heredoc operator came and no word since: it leaves no word, so the next word stands behind a redirection. `endWord`
  // gives that word `Typed.redir`. A redirection that leaves a word (`>f`, `2>&1`) is marked by `dropRedirections`.
  let afterHeredoc = false
  // A scope opens a list and a pipeline part of its own. Its close gives back the place it sat in.
  // `sub`: the shell takes the output of the commands inside (`$(`, a backtick and `<(`). A scope inside one keeps it.
  // `moved`: the output of the command around it is redirected before it, and it is a `>(`. A scope inside one keeps it.
  const openScope = (tick: boolean, arith: boolean, sub: boolean, moved = false, proc = false) => {
    const parent = stack.at(-1)
    const up = scopeNode()
    const node: ScopeNode = { n: ++scopes, up, from: out.length, end: Infinity, kids: [], direct: [] }
    up.kids.push(node)
    stack.push({
      node,
      n: scopes,
      proc,
      tick,
      saved: here(),
      andOr: andOrAt,
      compounds: compounds.length,
      arith,
      sub: sub || (parent?.sub ?? false),
      moved: moved || (parent?.moved ?? false),
      outerHead: cmdHead,
      outerWord: cmdWord,
      outerOut: cmdOut,
      bgFlagPending: bgFlag,
      from: out.length,
      anc: parent ? (holds(parent.n) ? parent.n : parent.anc) : 0,
    })
    listFrom = partFrom = out.length
    andOrAt = -1 // an `&&` outside is not in the list of the scope
    piped = false
    solo = []
    cmdHead = -1
    cmdWord = false
    cmdOut = false
  }
  // The innermost scope holds arithmetic text. A `(` in it is a grouping parenthesis, so it holds arithmetic text too; a
  // `$(` in it is a command substitution, and what is in that is a command again.
  const inArith = () => stack.at(-1)?.arith === true
  // The text from `from`, just behind an opening `((`, is an arithmetic expression: a `)` that no inner `(` holds is right
  // behind by a second `)` (`((1<<2))`). Any other `)` closes a subshell in a subshell (`((cd /x); y)`), the form that bash
  // falls back to. Quotes and escapes hide their parentheses. The scan is local, so a quote or a comment earlier in the
  // command cannot throw it off. An arithmetic expression is short: past `MAX_ARITH` characters the scan gives up and the
  // text is no arithmetic (as before issue #194), so a run of unterminated or nested `((` costs O(n), not O(n^2). The
  // character behind the `)` that ends the scan is read all the same.
  const MAX_ARITH = 256
  // The index of the quote that closes the one at `k`, or `end` or more when none does before `end`. A backslash hides a
  // character in double quotes, and nothing hides one in single quotes.
  const skipQuote = (k: number, end: number): number => {
    const q = s[k]
    let j = k + 1
    while (j < end && s[j] !== q) j += q === '"' && s[j] === '\\' ? 2 : 1
    return j
  }
  const arithFollows = (from: number): boolean => {
    let depth = 0
    const end = Math.min(s.length, from + MAX_ARITH)
    for (let k = from; k < end; k++) {
      const ch = s[k]!
      if (ch === '\\') k++
      else if (ch === "'" || ch === '"') k = skipQuote(k, end)
      else if (ch === '(') depth++
      else if (ch === ')') {
        if (depth === 0) return s[k + 1] === ')'
        depth--
      }
    }
    return false
  }
  // The `)` that closes the `(` at `open`, or -1: a command or arithmetic substitution in the tag of a heredoc
  // (`<<$(echo EOF)`, `<<$((1+1))`). Quotes and escapes hide their parentheses. A tag is short, so the scan stops after
  // `MAX_SUB` characters, and a run of `<<$(` that never closes costs O(n), not O(n^2).
  const MAX_SUB = 256
  const subEnd = (open: number): number => {
    let depth = 0
    const end = Math.min(s.length, open + MAX_SUB)
    for (let k = open; k < end; k++) {
      const ch = s[k]!
      if (ch === '\\') k++
      else if (ch === "'" || ch === '"') k = skipQuote(k, end)
      else if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) return k
    }
    return -1
  }
  // The word after `<<`, with its quotes and backslashes removed, up to a blank or an operator that was not quoted: the tag
  // of a heredoc. `\EOF`, `'EOF'`, `$'EOF'` and `E"O"F` all name `EOF`. A `$(` or `$((` is part of the tag up to its closing
  // `)`, as typed. No word, a quote that never closes and a substitution that never closes give none.
  // A backslash escape inside `$'...'` (`\n`, `\x41`) is not read: the text keeps it, as the KB page says.
  const readTag = (from: number): { text: string; end: number } | undefined => {
    let text = ''
    let k = from
    while (k < s.length && !/[\s;&|<>()`]/.test(s[k]!)) {
      const ch = s[k]!
      if (ch === '\\') {
        if (s[k + 1] !== '\n') text += s[k + 1] ?? ''
        k += 2
      } else if (ch === '$' && (s[k + 1] === "'" || s[k + 1] === '"')) {
        k++ // `$'EOF'` and `$"EOF"` quote the tag as `'EOF'` and `"EOF"` do: the `$` goes and the next round reads the quote
      } else if (ch === '$' && s[k + 1] === '(') {
        // `$(echo EOF)` and `$((1+1))`: bash does not expand the tag, so the text of the substitution is part of it, as typed.
        const end = subEnd(k + 1)
        if (end === -1) return undefined
        text += s.slice(k, end + 1)
        k = end + 1
      } else if (ch === "'") {
        const end = s.indexOf("'", k + 1)
        if (end === -1) return undefined
        text += s.slice(k + 1, end)
        k = end + 1
      } else if (ch === '"') {
        let j = k + 1
        while (j < s.length && s[j] !== '"') {
          // In double quotes a backslash escapes only `$`, a backtick, a quote, a backslash and a newline.
          if (s[j] === '\\' && '$`"\\\n'.includes(s[j + 1] ?? 'x')) {
            if (s[j + 1] !== '\n') text += s[j + 1]
            j += 2
          } else text += s[j++]
        }
        if (j >= s.length) return undefined
        k = j + 1
      } else {
        text += ch
        k++
      }
    }
    return k === from ? undefined : { text, end: k }
  }
  const closeScope = () => {
    const top = stack.pop()
    if (top) {
      top.node.end = out.length
      back(top.saved)
      andOrAt = top.andOr
      closedFrom = top.from
      cmdHead = top.outerHead
      cmdWord = top.outerWord
      cmdOut = top.outerOut
      bgFlag = top.bgFlagPending ?? (top.proc ? { shell: stack.at(-1)?.n ?? 0, at: out.length } : undefined)
    }
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
  // Moves the segments of `from` and the scopes that hold only segments from `from` on, right under `node`, to `to`.
  const takeFrom = (node: ScopeNode, to: ScopeNode, from: number) => {
    let d = node.direct.length
    while (d > 0 && node.direct[d - 1]! >= from) d--
    to.direct = node.direct.splice(d)
    for (const j of to.direct) scopeOfSegment[j] = to
    let k = node.kids.length
    while (k > 0 && node.kids[k - 1]!.from >= from) k--
    to.kids = node.kids.splice(k)
    for (const kid of to.kids) kid.up = to
  }
  // The segments from `from` run in a subshell of their own: a background list or a pipeline part. They move to a child
  // of the current scope. Every segment of them sits in that scope or in a scope under it. A part that holds only
  // subshells has scopes of its own already, and a wrapper scope with no segment changes nothing. So it moves nothing:
  // else each `)` of a deep `( a | ( b | ... ) )` would relabel every inner segment again. The move takes the segments and
  // the scopes right under the current one (issue #380): a scope deeper in the part goes with its parent, and its id is
  // written only at the end. Both lists are sorted, and the moved ones are at their end, so a move costs what it takes.
  const moveToChild = (from: number) => {
    const parent = scopeNode()
    const direct = parent.direct
    if (direct.length === 0 || direct[direct.length - 1]! < from) return
    const child: ScopeNode = { n: ++scopes, up: parent, from, end: out.length, kids: [], direct: [] }
    takeFrom(parent, child, from)
    // A scope that opened before `from` and holds segments from it on goes in two: its segments from `from` on move with the
    // part, under the same number. Only text that is no valid shell does that (a `)` that closes a `<(` while a loop in it is
    // still open), and it is how the ids were cut before. The kids do not overlap, so only the last one can hold `from`.
    for (let into = child, outer = parent.kids.at(-1); outer && outer.end > from; ) {
      const part: ScopeNode = { n: outer.n, up: into, from, end: outer.end, kids: [], direct: [] }
      outer.end = from
      takeFrom(outer, part, from)
      into.kids.unshift(part)
      into = part
      outer = outer.kids.at(-1)
    }
    parent.kids.push(child)
  }
  // The segments from `from` are a part of a pipeline: a shell of its own for `$!` (issue #353). The segments that the shell `n`
  // around it reads, or whose `&` it reads, move to a new number `p`. A segment in a shell inside the part whose `shellUp` is `n`
  // now reads `p`, when a segment of `p` came before it. The `&` that ends the pipeline (`bgEnd`) is read by `n`, so the last
  // segment keeps `bgShell` `n`. The lists in `writers` and `ups` are sorted, and only their end is in the part, so each segment
  // leaves a list once: O(n) in all, also for a deep nest of pipelines.
  const partShell = (from: number, bgEnd: boolean) => {
    cover(pipeAll, from, out.length)
    const n = stack.at(-1)?.n ?? 0
    const list = writers.get(n)
    if (!list) return
    let k = list.length
    while (k > 0 && list[k - 1]! >= from) k--
    if (k === list.length) return
    const moved = list.splice(k)
    const p = --partShells // a negative number: no scope has it
    const anc = stack.at(-1)?.anc ?? 0
    // A flag whose `&` came before the part (`( a ) & true | b`) stays with `n`. Its segment is the first one of the part.
    const flagBefore = (j: number) => out[j]!.afterBgShell && out[j]!.flagShell === n && flagAt[j]! <= from
    // `n` held a segment before the part, or a flag of `n` comes first in it: the part starts with the `$!` of `n`. Else it
    // starts with the one of the shell around `n`. The segment of that flag keeps the old rule: its flag makes the state of `n`.
    const before = k > 0 ? n : anc
    const up = k > 0 || flagBefore(moved[0]!) ? n : anc
    const last = out.length - 1
    // The segments in the part that read `n` so far: shells inside the part, and the parts of a pipeline inside it.
    const upList = ups.get(n) ?? []
    let u = upList.length
    while (u > 0 && upList[u - 1]! >= from) u--
    const tail = upList.splice(u)
    const movedUps: number[] = []
    let firstP = -1
    for (const j of moved) {
      const seg = out[j]!
      if (seg.shell === n) {
        seg.shell = p
        seg.shellUp = j === from && flagBefore(j) ? before : up
        if (seg.shellUp === n) movedUps.push(j)
      }
      if (seg.bgShell === n) seg.bgShell = bgEnd && j === last && seg.bg ? n : p
      if (seg.flagShell === n && !flagBefore(j)) seg.flagShell = p
      if (seg.bgShell === n || (seg.afterBgShell && seg.flagShell === n)) list.push(j)
      if (firstP < 0 && (seg.shell === p || seg.bgShell === p || seg.flagShell === p)) firstP = j
    }
    // A shell inside the part that reads `n` reads `p` now, once `p` holds a state: after its first segment. The rest still
    // reads `n`, and stays in the list, in order.
    const kept: number[] = []
    for (const j of tail) {
      if (out[j]!.shellUp !== n) continue
      if (firstP >= 0 && j > firstP) out[j]!.shellUp = p
      else kept.push(j)
    }
    let a = 0
    let b = 0
    while (a < kept.length || b < movedUps.length)
      upList.push(b >= movedUps.length || (a < kept.length && kept[a]! < movedUps[b]!) ? kept[a++]! : movedUps[b++]!)
    if (!ups.has(n)) ups.set(n, upList)
  }
  // The pipeline ends: its last part runs in a subshell too, and the next part starts after the segments so far. A flag that
  // waits in that part (`cat | { { :; } & }`) ends with it. A `&` that ends the pipeline keeps its own flag (`cat | { :; } &`).
  const endPipe = (keepBg = false) => {
    if (piped) {
      moveToChild(partFrom)
      partShell(partFrom, keepBg)
      if (!keepBg) bgFlag = undefined
      else for (const k of solo) out[k]!.bgPart = true // a `&` ends the pipeline: its parts before the last run in the background
    }
    piped = false
    partFrom = out.length
    solo = []
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
        heads.push({ head: typedHead, whole: plain, redir: afterHeredoc })
        afterHeredoc = false
      }
    }
    word = ''
    inWord = false
    typedHead = 0
    headOpen = true
    paramOpen = 0
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
    afterHeredoc = false // a heredoc at the end of a segment marks no word of the next one
    segOut = segPlaced = false
    if (inPattern()) {
      // The words of a pattern are no command: they open or close no compound, and `cd)` moves no folder.
      words = []
      heads = []
      return
    }
    const { words: clean, heads: cleanHeads, stdout, stdoutPlaced } = dropRedirections(words, heads)
    segOut = stdout
    segPlaced = stdoutPlaced
    // The words after the `}` or `)` of a group that only redirect (`{ a; } > f`) make no segment: the group is redirected.
    if (clean.length === 0 && stdout && closedFrom >= 0) redirected(closedFrom)
    // A `&` behind the close, with no word of its own (`{ a; } &`, `( a ) 2>&1 &`, `x=$(a) &`), sends that shell to the background.
    // A bare redirection (`> f &`) runs as a shell of its own, and so sets `$!` (issue #263).
    if (bg && clean.length === 0 && (closedFrom >= 0 || words.length > 0))
      bgFlag = { shell: stack.at(-1)?.n ?? 0, at: out.length }
    if (clean.length > 0) {
      const shellNow = stack.at(-1)?.n ?? 0
      const upNow = stack.at(-1)?.anc ?? 0
      out.push({
        words: clean.map(unmarkDollars),
        marked: clean,
        whole: cleanHeads.map(h => h.whole),
        redir: cleanHeads.map(h => h.redir),
        bg,
        afterBgShell: bgFlag !== undefined,
        bgList: bg && andOrAt >= listFrom,
        shell: shellNow,
        shellUp: upNow,
        bgShell: shellNow,
        flagShell: bgFlag?.shell ?? shellNow,
        bgPart: false,
        inPipe: false,
        cmdTail: cmdHead >= 0 && cmdWord,
        scope: '',
        stdoutRedirected: stdout || (stack.at(-1)?.moved ?? false),
        stdoutPiped: false,
        substituted: stack.at(-1)?.sub ?? false,
      })
      const at = out.length - 1
      const node = scopeNode()
      scopeOfSegment[at] = node
      node.direct.push(at)
      push(writers, shellNow, at)
      push(ups, upNow, at)
      if (bgFlag) {
        flagAt[at] = bgFlag.at
        if (bgFlag.shell !== shellNow) push(writers, bgFlag.shell, at)
      }
      bgFlag = undefined
      if (stdout && bareExec(clean, cleanHeads)) execs.push(out.length - 1)
      const lead = compoundLead(clean, cleanHeads)
      if (lead.opens.length > 0) {
        // `if for i in 1; do ...; done; then` opens an `if` and a `for` in one segment: each gets its own level.
        for (const kind of lead.opens) {
          compounds.push({
            ...here(),
            isCase: kind === 'case',
            arm: 'head',
            fresh: false,
            paren: false,
            from: out.length - 1,
          })
          partFrom = out.length - 1
          piped = false
          solo = []
        }
        const top = compounds.at(-1)!
        if (top.isCase && clean[lead.at + 2] === 'in') startPattern(top)
      } else {
        // `esac` can follow a compound with no `;;` (`a | { b; } esac`), and `fi esac` or `done esac` close two compounds.
        // Each close ends the pipeline that is open in it, then gives back the place from before its compound. A redirection
        // on the closing segment (`done > f`) is one of the whole compound.
        for (let k = 0; closesAt(clean, cleanHeads, k); k++) {
          endPipe()
          const open = compounds.pop()
          if (open) {
            back(open)
            if (stdout) redirected(open.from)
          }
        }
      }
    }
    // A redirection after a substitution (`docker run -d $(a) nginx > f`) is one of the whole command, its head too.
    if (stdout && cmdHead >= 0) cover(redirRuns, cmdHead, out.length)
    words = []
    heads = []
  }
  // A typed `>`, `<` or `&>` ends the word in front of it, as in bash: `nginx>f` is the word `nginx` and the redirection `>f`
  // (issue #231). Not when the text in front is a file descriptor of a `>` or `<` (`2>f`, `{fd}>f`) or the `&` of `&>f`, which
  // belongs to the redirection, or when it is inside arithmetic (`$((1>2))`) or an open `${ ... }`, where the character is text.
  // The `&` of `&>` has no descriptor form (`12&>f` is the word `12` and `&>f`), so it asks `textBeforeRedirect` alone. Each test
  // is O(1), or it reads a word that the split then ends, so a run of `>` in one word costs O(n), not O(n^2).
  const textBeforeRedirect = () => inWord && !inArith() && paramOpen === 0
  const splitsAtRedirect = () => textBeforeRedirect() && !(headOpen && FD_OR_AMP.test(word))
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
    // Heredoc: `<<TAG`, `<<-TAG`, `<<'TAG'`, `<<\TAG`. The body starts after the next newline. The `<<` inside a here-string
    // (`<<<`) is none: the first `<` of `<<<` is rejected by the third `<`, and the second one by the typed `<` just before
    // it. A quoted or escaped `<` before the pair (`\<<<EOF`) is a word, so the heredoc stays. In arithmetic text `<<` is a
    // shift (`$((1<<2))`), and that is no heredoc either.
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && typedRedir !== i - 1 && !inArith()) {
      // A file descriptor glued to the `<<` (`3<<EOF`, `{fd}<<EOF`) is part of the redirection, no word of the command. Only
      // a typed one counts: `a3<<EOF` and `'3'<<EOF` keep their word.
      if (inWord && headOpen && FD_WORD.test(word)) {
        word = ''
        inWord = false
        typedHead = 0
      } else endWord()
      afterHeredoc = true
      let j = i + 2
      const strip = s[j] === '-'
      if (strip) j++
      while (s[j] === ' ' || s[j] === '\t') j++
      const tag = readTag(j)
      if (tag) {
        heredocs.push({ tag: tag.text, strip })
        i = tag.end
        continue
      }
      i += 2
      continue
    }
    // `&` inside a redirection (`2>&1`, `>&2`, `&>file`, `&>>file`) is not an operator. The `>` or `<` just before must be
    // typed: after a quoted or escaped one (`'>'&`, `\>&`) the `&` runs the command in the background.
    if (c === '&' && (typedRedir === i - 1 || s[i + 1] === '>')) {
      // `nginx&>f`: the word ends, `&>f` is the redirection. A number or `{name}` in front is a word too: bash has no `N&>` form.
      if (typedRedir !== i - 1 && textBeforeRedirect()) endWord()
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
    // A `<` or `>` after the `}` ends it too (`{ a; }>f`, `done>f`): the redirection is then one of the group.
    const wordEnds =
      i + 1 >= s.length || /[\s;&|)<>]/.test(s[i + 1]!) || (s[i + 1] === '`' && stack.at(-1)?.tick === true)
    if ((op === '{' || op === '}') && (inWord || !wordEnds || inPattern())) {
      if (op === '{' && word.endsWith('$')) paramOpen++
      else if (op === '}' && paramOpen > 0) paramOpen--
      typed(c)
      i++
      continue
    }
    if (op) {
      const pending = inWord || words.length > 0
      // The word `in` or `esac` can change where the reader is in a `case`, so it ends before the operator is read.
      endWord()
      // A `(` right behind a typed `<` or `>` opens a process substitution (`<(cmd)`, `>(cmd)`). The `<` or `>` is its opener:
      // a word of its own, so `tee >(a) x` redirects nothing, and `a > >(b)` still does through the first `>`. `outputSub`: it
      // is a `>(`, whose commands write where the command around it writes. A `<(` and any other form that reaches here (`2>(`)
      // are read as before: the shell takes the output of the commands in them.
      let outputSub = false
      let procSub = false
      if (op === '(' && typedRedir === i - 1 && heads.at(-1)?.head === 1 && /^[<>]$/.test(words.at(-1) ?? '')) {
        procSub = true
        outputSub = words.pop() === '>'
        heads.pop()
      }
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
      const before = out.length
      endSegment(op === '&')
      closedFrom = -1 // a redirection counts for the group that closed right before it, and only until the next operator
      // The simple command goes on after a substitution, so it keeps its head: the first segment that the substitution cut off.
      // Any other operator ends the command.
      const goesOn = op === '$(' || op === '`' || (op === '(' && typedRedir === i - 1)
      // A `>(` takes the redirection of fd 1 that stood before it in the command, but not the `>` that has it as the target
      // (`a > >(b)`), which the segment before it still waits on. The command after it has both.
      const movedBefore = cmdOut || segPlaced
      cmdOut ||= segOut
      if (!goesOn) {
        cmdHead = -1
        cmdWord = false
        cmdOut = false
      } else if (out.length > before) {
        if (cmdHead < 0) cmdHead = out.length - 1
        if (!cmdWord) cmdWord = (out.at(-1)?.words ?? []).some(w => !ASSIGN.test(w))
      }
      if (op === '(') {
        // A `(` in front of the first word of a pattern list is part of the pattern, no subshell. The segment above can have
        // ended the header just now (`case x in(x)`), so the case is read again.
        const c = theCase()
        if (c?.arm === 'pattern' && c.fresh && !c.paren) c.paren = true
        // A `(` right behind a typed `<` or `>` (`<(cmd)`, `>(cmd)`) is a process substitution. The shell takes the output of
        // the commands in a `<(`, and no output of the ones in a `>(`: they write where the command around it writes.
        else
          openScope(
            false,
            inArith() || (s[i + 1] === '(' && !/[<>]/.test(s[i - 1] ?? '') && arithFollows(i + 2)),
            typedRedir === i - 1 && !outputSub,
            outputSub && movedBefore,
            procSub,
          )
      } else if (op === '$(') {
        openScope(false, s[i + 2] === '(' && arithFollows(i + 3), true)
      } else if (op === ')') {
        endPipe()
        // A `)` in a `case` closes no scope: the pattern ends there. The arm after it is a list of its own.
        if (theCase()) listFrom = out.length
        else if (!stack.at(-1)?.tick) closeScope()
      } else if (op === '`') {
        if (stack.at(-1)?.tick) {
          endPipe()
          closeScope()
        } else openScope(true, false, true)
      } else if (op === '{') {
        groups.push({ ...here(), from: out.length, andOr: andOrAt })
        andOrAt = -1
        listFrom = partFrom = out.length // the group opens a list and a part of its own; `}` gives back the outer ones
        piped = false
        solo = []
      } else if (op === '}') {
        endPipe()
        const outer = groups.pop()
        if (outer) {
          back(outer)
          andOrAt = outer.andOr
          closedFrom = outer.from
        }
      } else if (op === '|' || op === '|&') {
        moveToChild(partFrom) // the part before the `|` runs in a subshell
        partShell(partFrom, false) // and in a shell of its own for `$!`
        if (out.length - partFrom === 1) solo.push(partFrom)
        bgFlag = undefined // and a flag that waits in it ends with it (`{ { :; } & } | cat`)
        cover(pipeRuns, partFrom, out.length) // and its output feeds the next part
        partFrom = out.length
        piped = true
      } else if (op === '&') {
        endPipe(true)
        moveToChild(listFrom)
        listFrom = out.length
        andOrAt = -1 // the list ends here, even when its last command made no segment (`a && > f &`)
      } else if (op === ';' || op === ';;' || op === ';&' || op === ';;&' || (op === '\n' && !wantsMore)) {
        endPipe()
        listFrom = out.length
        andOrAt = -1 // the same (`a && > f; b &`)
        // The end of an arm: the next words are a pattern list.
        const arm = theCase()
        if (op.length > 1 && arm?.arm === 'arm') startPattern(arm)
      } else if (op === '&&' || op === '||') {
        endPipe()
        andOrAt = out.length
      }
      if (op !== '\n') wantsMore = op === '&&' || op === '||' || op === '|' || op === '|&'
      i += op.length
      if (op === '\n') skipHeredocs()
      continue
    }
    if (c === '>' || c === '<') {
      // The second character of `>>`, `<>` and `<<<` is part of the operator: only the first one ends the word.
      if (typedRedir !== i - 1 && splitsAtRedirect()) endWord()
      typedRedir = i
    }
    typed(c)
    i++
  }
  endSegment(false)
  endPipe()
  // The id of each scope: the path of numbers from the top, `''` for the top level. Each node writes its own once, behind the
  // one of its parent, so a deep nest costs one step per scope (issue #380).
  const ids = new Map<ScopeNode, string>([[root, '']])
  const idOf = (node: ScopeNode): string => {
    const chain: ScopeNode[] = []
    let cur = node
    while (!ids.has(cur)) {
      chain.push(cur)
      cur = cur.up!
    }
    let id = ids.get(cur)!
    for (let n = chain.length - 1; n >= 0; n--) {
      id = `${id}.${chain[n]!.n}`
      ids.set(chain[n]!, id)
    }
    return id
  }
  out.forEach((seg, k) => {
    seg.scope = idOf(scopeOfSegment[k]!)
  })
  // The first bare `exec` that redirects the output, per scope. A scope sees the earliest one of its own and of its parents
  // (`( exec > f; a )` marks `a`, and `( exec > f ); a` does not). The answer is kept per scope, so a long list of segments
  // in one scope costs one walk. Scopes are final here: a pipeline part or a background list has moved to a child of its own.
  const execIn = new Map<ScopeNode, number>()
  for (const k of execs) if (!execIn.has(scopeOfSegment[k]!)) execIn.set(scopeOfSegment[k]!, k)
  const execSeen = new Map<ScopeNode, number>()
  const execFrom = (node: ScopeNode): number => {
    const chain: ScopeNode[] = []
    let first = Infinity
    for (let cur: ScopeNode | undefined = node; cur; cur = cur.up) {
      const seen = execSeen.get(cur)
      if (seen !== undefined) {
        first = seen
        break
      }
      chain.push(cur)
    }
    for (let n = chain.length - 1; n >= 0; n--) {
      first = Math.min(first, execIn.get(chain[n]!) ?? Infinity)
      execSeen.set(chain[n]!, first)
    }
    return first
  }
  // Read the ranges of the pipes and of the redirected groups: a segment is marked when some range covers it.
  let piping = 0
  let redirecting = 0
  let inPipe = 0
  out.forEach((seg, k) => {
    piping += pipeRuns[k] ?? 0
    redirecting += redirRuns[k] ?? 0
    inPipe += pipeAll[k] ?? 0
    seg.stdoutPiped = piping > 0
    seg.inPipe = inPipe > 0
    if (redirecting > 0 || (execIn.size > 0 && execFrom(scopeOfSegment[k]!) < k)) seg.stdoutRedirected = true
  })
  return out
}

/**
 * Values per subshell scope (issue #380): a value set in a scope is seen in it and in the scopes under it, up to one that sets
 * its own. The scope `a.b.c` sits in `a.b`, and `''` is the top level. Each scope is a node with a link to its parent, made
 * once from its id. A lookup walks the links up to the nearest scope that set the name and remembers the answer in each
 * scope on the way. A scope that sets a name for the first time drops what was remembered for it (`vers`), unless no scope
 * under it was looked up yet: then no answer went through it. A name that no scope set costs nothing. So a deep nest of
 * subshells costs one step per scope, where a walk that cut the id at each level cost O(depth^2) per lookup. A scope id is a
 * string, so the first lookup of a new scope still reads its id once: O(depth) in the id length, the size of the output.
 */
function scopeTable(): {
  find: (scope: string, name: string) => { value: string | undefined } | undefined
  set: (scope: string, name: string, value: string | undefined) => void
} {
  type TableNode = {
    up: TableNode | undefined
    /** A scope under it was made: an answer remembered there can go through this scope. */
    kids: boolean
    values: Map<string, string | undefined>
    memo: Map<string, { ver: number; at: TableNode | undefined }>
  }
  const nodes = new Map<string, TableNode>()
  // For each name, how many scopes set it so far. A remembered answer of an older count may miss a scope in between.
  const vers = new Map<string, number>()
  const nodeFor = (scope: string): TableNode => {
    const chain: string[] = []
    let s = scope
    let found = nodes.get(s)
    while (!found) {
      chain.push(s)
      if (s === '') break
      s = s.slice(0, s.lastIndexOf('.'))
      found = nodes.get(s)
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      const made: TableNode = { up: found, kids: false, values: new Map(), memo: new Map() }
      if (found) found.kids = true
      nodes.set(chain[k]!, made)
      found = made
    }
    return found!
  }
  return {
    find(scope, name) {
      const ver = vers.get(name)
      if (ver === undefined) return undefined
      const chain: TableNode[] = []
      let at: TableNode | undefined
      for (let cur: TableNode | undefined = nodeFor(scope); cur; cur = cur.up) {
        if (cur.values.has(name)) {
          at = cur
          break
        }
        const memo = cur.memo.get(name)
        if (memo?.ver === ver) {
          at = memo.at
          break
        }
        chain.push(cur)
      }
      for (const node of chain) node.memo.set(name, { ver, at })
      return at && { value: at.values.get(name) }
    },
    set(scope, name, value) {
      const node = nodeFor(scope)
      if (!node.values.has(name) && (node.kids || !vers.has(name))) vers.set(name, (vers.get(name) ?? 0) + 1)
      node.values.set(name, value)
    },
  }
}

/**
 * A working directory per subshell scope. `get` finds the nearest scope that set one, else `start` (`scopeTable`).
 * `set(scope, undefined)` records an unknown directory, which hides the parent's.
 */
export function scopedDir(start: string | undefined): {
  get: (scope: string) => string | undefined
  set: (scope: string, dir: string | undefined) => void
} {
  const table = scopeTable()
  return {
    get: scope => {
      const found = table.find(scope, '')
      return found ? found.value : start
    },
    set: (scope, dir) => table.set(scope, '', dir),
  }
}

/**
 * Shell variables per subshell scope, the same lookup as `scopedDir`. `get` finds the value in the nearest scope that set
 * the name: a variable set in a subshell does not reach its parent, and a child reads its parent's. `set(scope, name,
 * undefined)` records an unknown value, which hides the parent's.
 */
export function scopedVars(): {
  get: (scope: string, name: string) => string | undefined
  set: (scope: string, name: string, value: string | undefined) => void
} {
  const table = scopeTable()
  return {
    get: (scope, name) => table.find(scope, name)?.value,
    set: (scope, name, value) => table.set(scope, name, value),
  }
}

// The file descriptor in front of a redirection operator: a number (`2>f`) or a variable (`{fd}>f`, issue #194). Bash
// stores the descriptor that it opens in `$fd`. A name that is no identifier (`{1x}`, `{a b}`) is a word.
const FD = String.raw`(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})`
const FD_WORD = new RegExp(`^${FD}$`)
// The text in front of a `>` or `<` that is part of the redirection and no word of the command: `2` and `{fd}` of `2>f`, `&` of `&>f`.
const FD_OR_AMP = new RegExp(`^(?:${FD}|&)$`)
// `<>` stands before `<<?<?`: that branch matches the lone `<` of `<>` and leaves the `>` in the target (issue #183).
const REDIRECT = new RegExp(String.raw`^(?<fd>${FD}?|&)(?<op>>\||>>?|<>|<<?<?|>&|<&)(?<rest>.*)$`)

/**
 * The words after `exec` are only its options: `-c`, `-l`, `-a name`, joined as getopt reads them (`-cl`, `-cla name`, `-aname`),
 * and `--`. They matter only when a command follows. `-a` with no name is an error in bash, and counts as an option all the
 * same: the later commands are then marked, the safe side. Any other word, and any word after `--`, is the command.
 */
const execOptionsOnly = (rest: readonly string[]): boolean => {
  for (let k = 0; k < rest.length; ) {
    const w = rest[k]!
    if (w === '--') return k + 1 === rest.length
    const m = /^-[cl]*(?:(a)(.*))?$/.exec(w)
    if (!m || w === '-') return false
    k += m[1] !== undefined && m[2] === '' ? 2 : 1 // `-a` takes the next word as its name
  }
  return true
}

/**
 * The segment is a bare `exec`: no command follows it, so its redirections stay on the shell itself (`exec > f`, `exec 3>&1`).
 * `stripLead` drops `exec` as a wrapper, and nothing is left, or only the options of `exec` are (`exec -c > f`, `exec -a name
 * > f`: bash redirects the shell then too). Quotes do not matter: `'exec'` is the builtin too. A word that only holds the text
 * (`echo exec`) leaves a command, so it is no bare exec.
 */
const bareExec = (words: readonly string[], typed: readonly Typed[]): boolean => {
  if (!words.includes('exec')) return false
  const rest = stripLead({ words, whole: typed.map(t => t.whole), redir: typed.map(t => t.redir) }).words
  // `stripLead` stops at the first option of `exec`, so the word right before `rest` is the `exec` that the options belong to.
  return rest.length === 0 || (words[words.length - rest.length - 1] === 'exec' && execOptionsOnly(rest))
}

/**
 * The redirection sends fd 1 away (issue #231). `fd` is the descriptor in front of the operator: none or `&` for a `>` form
 * (`> f`, `>> f`, `>| f`, `>&2`, `&> f`), or `1` for any operator. A number other than 1 (`2>&1`), a `{name}` and an input
 * redirection with no number (`< f`, `<> f`, `<<< x`) leave the output alone. `>&2` and `>&-` count as one: they move or close it.
 * `>&1` copies fd 1 onto itself and moves nothing: `dropRedirections` checks it with `COPY_OF_STDOUT`.
 */
const sendsStdout = (fd: string, op: string): boolean =>
  /^\d+$/.test(fd) ? Number(fd) === 1 : (fd === '' || fd === '&') && op.startsWith('>')

/**
 * The target of a `>&` or `<&` that copies fd 1 onto itself: `1`, `01`, or `1-` (a move onto itself). Bash then saves nothing and
 * changes nothing (5.3.20: `echo hi >&1` prints, and `{ exec >/dev/null; } >&1; echo after` prints nothing), so with `>&1`, `1>&1`,
 * `>& 1` and `1<&1` the redirection sends fd 1 nowhere. Any other target moves it (`>&2`, `>&-`, `>&10`, `>&1x`, which is a file).
 * `dropRedirections` reads a target only after a `>` or `<` with no `&` in front. `&>&1` and `>>&1` are syntax errors in bash, so
 * they copy nothing and stay a redirection (the run takes no id, the safe side).
 */
const COPY_OF_STDOUT = /^0*1-?$/

/**
 * Drops redirections (`> f`, `2>&1`, `&>f`, `<f`, `<> f`, `<<< word`, `{fd}>f`) and their targets. `typed[i].head` is how
 * many of the first characters of `words[i]` were typed. Only that head can hold the redirection: a quoted or escaped `>`
 * is a word (`\>`, `'>'`, `2\>&1`), and so is the word after it (issue #162). Returns the kept words and their `Typed`,
 * and `stdout`: one of the redirections sends fd 1 away (`sendsStdout`). `stdoutPlaced` is `stdout` without the redirection at the
 * end of the words that has no target word yet (`a >`): the text that follows becomes its target (`a > >(b)`).
 * The first word that stays behind a dropped redirection gets `redir` (issue #227).
 */
function dropRedirections(
  words: readonly string[],
  typed: readonly Typed[],
): { words: string[]; heads: Typed[]; stdout: boolean; stdoutPlaced: boolean } {
  const out: { words: string[]; heads: Typed[]; stdout: boolean; stdoutPlaced: boolean } = {
    words: [],
    heads: [],
    stdout: false,
    stdoutPlaced: false,
  }
  // A redirection was dropped since the last word that stayed: the next one stands right behind it.
  let cut = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const t = typed[i]!
    const m = REDIRECT.exec(word.slice(0, t.head))
    if (!m) {
      out.words.push(word)
      out.heads.push(cut ? { ...t, redir: true } : t)
      cut = false
      continue
    }
    cut = true
    const { fd, op, rest } = m.groups! as { fd: string; op: string; rest: string }
    // `>&` and `<&` copy a descriptor (the regex reads the `&` as the start of `rest`). Their target stands behind the `&`, glued
    // (`>&1`, also quoted: `>&'1'`) or in the next word (`>& 1`, `>& f`), and that word is no word of the command. The target
    // stays empty for the other operators, so `sendsStdout` alone decides there.
    let target = ''
    if (rest.startsWith('&') && fd !== '&' && (op === '>' || op === '<')) {
      target = rest.slice(1) + word.slice(t.head)
      if (target === '' && t.whole) target = words[++i] ?? ''
    } else if (rest === '' && t.whole) {
      // `>` alone takes the next word as its target; `>file` and `2>&1` carry it. So does a target that was quoted or
      // escaped, right behind the typed `>` (`>\>`, `>'f g'`, and an empty quote: `>''`).
      i++
    }
    if (sendsStdout(fd, op) && !COPY_OF_STDOUT.test(target)) {
      out.stdout = true
      // A redirection at the end that takes the next word as its target, and has none, waits on what comes next (`a > >(b)`).
      if (i < words.length) out.stdoutPlaced = true
    }
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
 * `whole` says for each word that it was typed whole (`Segment.whole`). Only such a word is reserved: `'done' y` runs a
 * command named `done` (issue #194). Without `whole`, every word counts as typed.
 * `redir` says for each word that a redirection stood right before it (`Segment.redir`). bash reads a reserved word only
 * as the first word of a command, so one behind a redirection is the command: `>/dev/null ! x` fails with `!: command
 * not found` (issue #259). Without `redir`, no redirection stood anywhere. Only `stripLead` should call this function:
 * a direct caller that has the flags must pass `redir`, or issue #259 comes back with no error.
 */
export function stripReserved(
  words: readonly string[],
  whole?: readonly boolean[],
  redir?: readonly boolean[],
): string[] {
  let i = 0
  while (i < words.length && RESERVED.has(words[i]!) && whole?.[i] !== false && redir?.[i] !== true) i++
  return words.slice(i)
}

/**
 * Strips `VAR=x`, `sudo`, `env`, `time`, `command`, `exec`, `builtin`, `nice`, `nohup`, `timeout`, `gtimeout`, `ionice`,
 * `stdbuf`, `setsid`, `caffeinate`, `doas` from the front. Returns the env it set, and `fork`: a `setsid -f` was stripped.
 *
 * `time` takes its options with it (`time -p`, `time --`), but only the ones that were typed whole and have no
 * redirection right before them: `time "-p" git` and `time >/dev/null -p git` run a command named `-p`. A `time` that
 * runs behind a program wrapper (`sudo time -v make`) or that was quoted (`'time' -f %e git`) is the external
 * `/usr/bin/time`: it also takes `-f FMT`, `-o FILE` and the flags of GNU and BSD `time`.
 * An unknown flag keeps the text (issue #336). `command`, `exec` and `builtin` leave their
 * options in place.
 *
 * `timeout` and the like take their options and positional words (`timeout -s KILL 5`) with them (issue #242). They
 * are external programs and read quoted options too. `ionice -p` and `caffeinate -t 60` run no command, so they stay.
 *
 * `whole` says for each word that it was typed whole (`Segment.whole`, as for `stripReserved`), and `redir` that a
 * redirection stood right before it (`Segment.redir`). Without them, every word counts as typed and no redirection stood
 * anywhere. A caller that has the flags must pass them: `stripLead` does.
 */
export function stripWrappers(
  words: readonly string[],
  whole?: readonly boolean[],
  redir?: readonly boolean[],
): {
  words: string[]
  env: Record<string, string>
  nohup: boolean
  fork: boolean
} {
  const env: Record<string, string> = {}
  let nohup = false
  let fork = false
  let program = false
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
      program = true
      i++
      // Their own flags. `-u user`, `-n 10` take a value.
      while (i < words.length && words[i]!.startsWith('-')) {
        const f = words[i]!
        i += f === '-u' || f === '-g' || f === '-n' || f === '-C' ? 2 : 1
      }
      continue
    }
    // `time` has options of its own: `-p` and `--` belong to it, as `compoundLead` reads them too (issue #227).
    if (w === 'time' || EXTERNAL_TIME_NAMES.has(w)) {
      const plain = (k: number) => whole?.[k] !== false && redir?.[k] !== true
      if (w !== 'time' || whole?.[i] === false || program) {
        const got = skipWrapperOptions(EXTERNAL_TIME, words, i + 1)
        if (got.at === -1) break
        program = true
        i = got.at
      } else i = skipTimeOptions(words, i + 1, plain)
      continue
    }
    // The options of these three stay: `command -v git` looks `git` up and runs nothing.
    if (w === 'command' || w === 'exec' || w === 'builtin') {
      i++
      continue
    }
    if (w === 'nohup') {
      program = true
      nohup = true
      i++
      continue
    }
    // `timeout`, `ionice`, `stdbuf`, `setsid`, `caffeinate` and `doas` run the next command with options of their own
    // (issue #242).
    const spec = Object.hasOwn(WRAPPER_SPECS, w) ? WRAPPER_SPECS[w] : undefined
    if (spec) {
      const got = skipWrapperOptions(spec, words, i + 1)
      if (got.at === -1) break
      program = true
      fork ||= got.fork
      i = got.at
      continue
    }
    break
  }
  return { words: words.slice(i), env, nohup, fork }
}

/**
 * Strips the reserved words and the wrappers in front of a simple command, in any order. `time` is a reserved word that
 * comes before `!`, and `!` comes before `time`: `time ! git push`, `! time git push` and `if time ! git push` are all
 * valid shell. Each round drops the reserved words, then the wrappers, until nothing more goes. The env of every round
 * adds up: a later `VAR=x` wins. A program wrapper such as `sudo` before `!` is no valid shell: it reads the same way.
 * It takes the words with their typed flags (`Segment.whole`, as for `stripReserved`) and their redirection flags
 * (`Segment.redir`). It has no fallback for a caller that has none: a reader that leaves them out does not compile, so it
 * cannot bring issue #194 or issue #227 back unseen. A `Segment` fits.
 */
export function stripLead(seg: {
  words: readonly string[]
  whole: readonly boolean[]
  redir: readonly boolean[]
}): ReturnType<typeof stripWrappers> {
  const { words, whole, redir } = seg
  const env: Record<string, string> = {}
  let nohup = false
  let fork = false
  let rest = words
  for (;;) {
    // Both helpers only drop words from the front, so `rest` is always the end of `words`: its flags are the end of `whole`.
    // So are the words that `stripReserved` leaves, and `stripWrappers` reads their flags for the options of `time`.
    const kept = stripReserved(rest, whole.slice(words.length - rest.length), redir.slice(words.length - rest.length))
    const got = stripWrappers(kept, whole.slice(words.length - kept.length), redir.slice(words.length - kept.length))
    Object.assign(env, got.env)
    nohup ||= got.nohup
    fork ||= got.fork
    if (got.words.length === rest.length) return { words: got.words, env, nohup, fork }
    rest = got.words
  }
}

/**
 * Nothing sends the standard output of the segment away (issue #231): it goes where the shell's own output goes. A reader that
 * pairs an output line with a command (the id of `docker run -d`, the pid line of `echo $!`) calls this and reads no mark of
 * its own, so it cannot leave one out and bring the bug of #231 back unseen. A `Segment` fits.
 */
export const keepsStdout = (seg: Pick<Segment, 'stdoutRedirected' | 'stdoutPiped' | 'substituted'>): boolean =>
  !seg.stdoutRedirected && !seg.stdoutPiped && !seg.substituted

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
