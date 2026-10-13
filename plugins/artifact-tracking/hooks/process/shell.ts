// A small shell reader for the process parser. It splits one Bash command into simple commands.
// Not a full shell: enough to find `docker run -d`, `tmux new -d` and friends inside compound commands.
// Quoted text stays one word, so `bash -c '...'`, `ssh host '...'` and `echo "...; ..."` hide their insides.
// Heredoc bodies and comments are skipped.

export type Segment = {
  /** Words with quotes and escapes removed. Redirections are dropped. */
  words: string[]
  /** The segment ended with a single `&`: the shell runs it in the background. */
  bg: boolean
}

const OPS = ['&&', '||', '|&', ';', '|', '&', '\n', '(', ')', '`', '$(', '{', '}'] as const

/** Splits `command` into simple commands on `;`, `&&`, `||`, `|`, `&`, newlines, subshells and groups. */
export function splitShell(command: string): Segment[] {
  const out: Segment[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const heredocs: { tag: string; strip: boolean }[] = []
  let i = 0
  const s = command

  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = (bg: boolean) => {
    endWord()
    const clean = dropRedirections(words)
    if (clean.length > 0) out.push({ words: clean, bg })
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
      word += s[i + 1] ?? ''
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      word += s.slice(i + 1, end === -1 ? s.length : end)
      inWord = true
      i = end === -1 ? s.length : end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) {
          word += s[j + 1]
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
      endSegment(op === '&')
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
