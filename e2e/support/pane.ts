// The pane draws a one-cell gutter after its left border: ">" on the selected row, else a space.
// The transcript beside a docked pane can hold a ">" too, so the marker must follow the border.
const SELECTED = /│>/

// The first screen line that shows the selected row of the pane, or undefined when no row is selected.
export function selectedLine(screen: string): string | undefined {
  return screen.split('\n').find(line => SELECTED.test(line))
}
