// The pane draws a one-cell gutter on each row: ">" on the selected row, else a space. A docked pane puts the gutter right
// after its left border (`│>`). An inline pane, a box under the transcript, has a space of padding between the border and
// the gutter (`│ >`). The transcript beside a docked pane can hold a ">" too, so the marker must follow the border. The
// gutter is followed by a blank: the row content starts there.
const SELECTED = /│ ?>(?=\s)/

// The top border of an inline pane, with the close mark of Claude Code in it (`╭────✕─╮`).
const INLINE_TOP = /^╭─+✕─╮$/
// The row of a docked pane that holds the close mark: its border, blanks and the mark, with the transcript to the left.
// The mark is `✕` (U+2715). The `✗` of `✗ conflicts` is another character.
const DOCKED_TOP = /│ *✕(?: *│)? *$/

// Where the pane sits: `inline`, a box under the transcript, or `docked`, a column beside it. Undefined while the screen
// shows no pane. Claude Code decides by the width of the terminal, so a size that did not take effect shows here.
export function placementOf(screen: string): 'inline' | 'docked' | undefined {
  const lines = screen.split('\n')
  if (lines.some(line => INLINE_TOP.test(line))) return 'inline'
  return lines.some(line => DOCKED_TOP.test(line)) ? 'docked' : undefined
}

// The first screen line that shows the selected row of the pane, or undefined when no row is selected. An inline box has
// a top border: a bordered line of the transcript above it is no row of the pane, so the search starts at the border.
export function selectedLine(screen: string): string | undefined {
  const lines = screen.split('\n')
  const top = lines.findIndex(line => INLINE_TOP.test(line))
  return lines.slice(Math.max(top, 0)).find(line => SELECTED.test(line))
}

// A hyperlink (OSC 8) wraps text and has no width. The other tokens are an SGR sequence, any other CSI sequence, or text.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const TOKEN = /\u001b\[([0-9;:]*)m|\u001b\[[0-?]*[ -/]*[@-~]|([^\u001b]+)/g
// SGR 38, 48 and 58 (a color) take 2 more parameters after "5" (an index) and 4 after "2" (red, green, blue), counting
// the "5" or "2". Those are no attributes: the 7 in `38;5;7` is a color.
const COLOR_ARGS: Readonly<Record<string, number>> = { '5': 2, '2': 4 }

// The text of each run in reverse video (SGR 7) on a screen from `tmux capture-pane -e`. The focus ring draws the
// focused Button this way, and the pane marks no other thing with it. A run ends at a reset, at SGR 27 and at the end of
// its line. A run of blanks is not text: the cursor of the prompt is one.
export function focusedTexts(ansi: string): string[] {
  const found: string[] = []
  for (const line of ansi.replace(OSC, '').split('\n')) {
    let reversed = false
    let run = ''
    const end = () => {
      if (run.trim() !== '') found.push(run.trim())
      run = ''
    }
    for (const token of line.matchAll(TOKEN)) {
      const [, params, text] = token
      if (text !== undefined) {
        if (reversed) run += text
        continue
      }
      if (params === undefined) continue
      const codes = params === '' ? ['0'] : params.split(';')
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!
        if (code === '38' || code === '48' || code === '58') i += COLOR_ARGS[codes[i + 1] ?? ''] ?? 0
        else if (code === '7') reversed = true
        else if (code === '0' || code === '27') {
          if (reversed) end()
          reversed = false
        }
      }
    }
    end()
  }
  return found
}

// The last screen of a timeout error for a step that reads reverse video. The plain screen shows no reverse video, so
// the texts that the step looked at come after it.
export function withFocus(plain: string, ansi: string): string {
  return `${plain}\n--- reverse video: ${JSON.stringify(focusedTexts(ansi))}`
}

// The 1-based column and row of the arrow (`▸` closed, `▾` open) of the first row that shows `text`, and the arrow itself,
// or undefined. The arrow is the one place of a row that takes a click.
export function arrowOf(screen: string, text: string): { column: number; row: number; glyph: string } | undefined {
  const lines = screen.split('\n')
  for (const [at, line] of lines.entries()) {
    const found = /[▸▾] /.exec(line)
    if (found !== null && line.slice(found.index + 2).startsWith(text)) {
      return { column: found.index + 1, row: at + 1, glyph: line.charAt(found.index) }
    }
  }
  return undefined
}

// The 1-based column and row of the first `text` that the pane draws, or undefined. The transcript sits left of the pane,
// so only the part of a line after its first border (`│`) counts: the prompt may hold the same words.
export function paneTextAt(screen: string, text: string): { column: number; row: number } | undefined {
  for (const [at, line] of screen.split('\n').entries()) {
    const border = line.indexOf('│')
    if (border < 0) continue
    const found = line.indexOf(text, border + 1)
    if (found >= 0) return { column: found + 1, row: at + 1 }
  }
  return undefined
}

// Whether the pane draws `text` (issue #165). It reads the pane only, as `paneTextAt` does: the transcript beside it can hold
// the same words, for example the `/track` line that still names a row the pane dropped.
export function paneShows(screen: string, text: string): boolean {
  return paneTextAt(screen, text) !== undefined
}

// The strip of `ui.turnStrip: interactive` (issue #69, P2): one transcript row under the duration line, two cells in, with
// the counts and the Button `open` (`  +3 new · 1 seen again open`). A docked pane may follow on the same screen line, after
// a border. The band says `9: open` and starts with `tracking`, so it never matches.
const STRIP = /^ {2}(?:\+\d+ new|\d+ seen again)(?: · \d+ seen again)? open(?= *(?:│|$))/

// The 1-based column and row of the Button `open` of the first strip row, one cell inside the word (the click lands on its
// second letter), or undefined. The main screen draws the counts with no Button, so no row matches there.
export function stripOpenAt(screen: string): { column: number; row: number } | undefined {
  for (const [at, line] of screen.split('\n').entries()) {
    const found = STRIP.exec(line)
    if (found !== null) return { column: found[0].length - 'open'.length + 2, row: at + 1 }
  }
  return undefined
}

// The age that a section note gives its last refresh: `gh · refreshed just now`, `gh · refreshed 3s ago`. The note comes
// after the ` · ` that follows the tool, so a line of the transcript that says "refreshed 3s ago" is no note.
const REFRESHED = / · refreshed (?:just now|(\d+)([smhd]) ago)/
const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 }

// How old the last refresh is, in seconds, as the first section note of the screen says it (`just now` is 0), or undefined
// while no section says it refreshed. The pane draws the age when it draws, so the number is the age at that drawing.
// The age is read from the screen and not the clock of the harness, so a scenario compares what the person would see.
export function refreshAge(screen: string): number | undefined {
  for (const line of screen.split('\n')) {
    const found = REFRESHED.exec(line)
    if (found === null) continue
    const [, count, unit] = found
    return count === undefined ? 0 : Number(count) * (UNIT_SECONDS[unit as string] as number)
  }
  return undefined
}
