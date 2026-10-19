// A plain-data element table for node tests: each member builds `{ type, props, children }`, the shape the node
// stand-in for `h` builds (scripts/coverage/kit-shim.ts) and the engine builds (tests/h-shape.kit.test.ts).
// Task 3 points this at `TableElements`.

type Props = Record<string, unknown>
export type ElementTable = Record<'Box' | 'Text' | 'Button' | 'Link', (p: Props) => unknown>

const plain =
  (type: string) =>
  ({ children, ...props }: Props) => ({ type, props, children: children ?? [] })

export const EL: ElementTable = {
  Box: plain('Box'),
  Text: plain('Text'),
  Button: plain('Button'),
  Link: plain('Link'),
}
