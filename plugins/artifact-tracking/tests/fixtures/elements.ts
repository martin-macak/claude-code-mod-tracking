// A plain-data element table for node tests: each member builds `{ type, props, children }`, the shape the node
// stand-in for `h` builds (scripts/coverage/kit-shim.ts) and the engine builds (tests/h-shape.kit.test.ts).
import type { TableElements } from '../../ux/tree-data-table/el'

type Props = Record<string, unknown>

const plain =
  (type: string) =>
  ({ children, ...props }: Props) => ({ type, props, children: children ?? [] })

export const EL = {
  Box: plain('Box'),
  Text: plain('Text'),
  Button: plain('Button'),
  Link: plain('Link'),
} as unknown as TableElements
