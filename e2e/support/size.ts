// Why a scenario cannot set its terminal size now, or undefined when it can. The step runs before the session starts:
// claude draws for the size it starts at. A recording has its size fixed in the cast header, from DEMO_COLS and DEMO_ROWS.
export function sizeRefusal(state: { record: boolean; launched: boolean }): string | undefined {
  if (state.record) return 'terminal size: a recorded scenario (DEMO_RECORD=1) runs at DEMO_COLS x DEMO_ROWS'
  if (state.launched) return 'terminal size: set it before the step that starts the session'
  return undefined
}
