// The pane draws a one-cell gutter after its left border: ">" on the selected row, else a space.
// The transcript beside a docked pane can hold a ">" too, so the marker must follow the border.
const SELECTED = /│>/

// The first screen line that shows the selected row of the pane, or undefined when no row is selected.
export function selectedLine(screen: string): string | undefined {
  return screen.split('\n').find(line => SELECTED.test(line))
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
