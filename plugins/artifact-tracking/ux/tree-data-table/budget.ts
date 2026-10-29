// The budget guard. The engine refuses a pane tree over 20,000 counted values (the pane is blank) and drops the later
// Buttons past 100,000 characters, the footer too, and the mod sees neither (E12, tree-table 3.6). The guard counts
// what the engine counts, with a margin, and reserves the footer first, so a cut never removes the keys.
// Spec 5.10 "Budget"; decision G18 of plan L6. Pure.

/** What a tree costs: counted values (nodes plus string children) and characters. */
export interface Cost {
  readonly values: number
  readonly chars: number
}

/** The limits the guard keeps, a margin below the engine's own. */
export const BUDGET: Cost = { values: 15000, chars: 80000 }

interface Node {
  readonly type?: unknown
  readonly props?: Readonly<Record<string, unknown>>
  readonly children?: unknown
}

const lengthOf = (v: unknown): number => (typeof v === 'string' ? v.length : 0)

/**
 * The cost of a tree of `{ type, props, children }` nodes and lists of them. A node with a string type is 1 value. A
 * string child is 1 value and its length in characters, a number child the same for its text. A Button adds its
 * label, a Box its key, a Link its href and label, a Code its source and a Markdown its text (the engine counts both: a `Code`
 * of 120,000 characters draws 100,000 and drops the Buttons after it, issue #57). A Button key and every other prop count
 * nothing. The engine and the node stand-in leave out an empty props and an empty children, so both may be missing.
 */
export function measure(tree: unknown): Cost {
  let values = 0
  let chars = 0
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
    } else if (typeof node === 'string' || typeof node === 'number') {
      values += 1
      chars += String(node).length
    } else if (typeof node === 'object' && node !== null) {
      const { type, props = {}, children } = node as Node
      if (typeof type === 'string') {
        values += 1
        if (type === 'Button') chars += lengthOf(props.label)
        else if (type === 'Box') chars += lengthOf(props.key)
        else if (type === 'Link') chars += lengthOf(props.href) + lengthOf(props.label)
        else if (type === 'Code') chars += lengthOf(props.source)
        else if (type === 'Markdown') chars += lengthOf(props.text)
      }
      walk(children)
    }
  }
  walk(tree)
  return { values, chars }
}

export function fits(c: Cost, limit: Cost): boolean {
  return c.values <= limit.values && c.chars <= limit.chars
}

/**
 * The body of the first attempt that fits in `limit` less the footer, else `tooLarge()`. `step` is the index of that
 * attempt, or `attempts.length` for `tooLarge`. The footer is measured once. An attempt runs only when the ones
 * before it did not fit.
 */
export function guard<T>(
  footer: unknown,
  attempts: readonly (() => T)[],
  tooLarge: () => T,
  limit: Cost = BUDGET,
): { readonly body: T; readonly step: number } {
  const reserved = measure(footer)
  const room: Cost = { values: limit.values - reserved.values, chars: limit.chars - reserved.chars }
  for (const [step, attempt] of attempts.entries()) {
    const body = attempt()
    if (fits(measure(body), room)) return { body, step }
  }
  return { body: tooLarge(), step: attempts.length }
}
