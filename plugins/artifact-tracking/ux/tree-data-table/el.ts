// Typed wrappers over the global `h`. A `ux/` module is `.ts`, so node can load and measure it (spec 7.1).
// `h` takes `Record<string, unknown>`, so tsc cannot check a prop. One bad prop refuses the whole pane, and the
// engine tells the mod nothing. These wrappers type every prop of Box, Text, Button and Link.
import type {
  BoxProps,
  ButtonProps,
  CodeProps,
  Elements,
  LinkProps,
  MarkdownProps,
  RenderChildren,
  RenderElement,
  TextProps,
} from 'claude-code'

/** The element table `ui.resolve(e)` hands out, cut to the six tags the pane draws (`Code` and `Markdown` draw the preview). */
export type TableElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link' | 'Code' | 'Markdown'>

export function box(el: Pick<TableElements, 'Box'>, props: BoxProps, ...children: RenderChildren[]): RenderElement {
  return h(el.Box, props, ...children) as RenderElement
}

export function text(el: Pick<TableElements, 'Text'>, props: TextProps, ...children: RenderChildren[]): RenderElement {
  return h(el.Text, props, ...children) as RenderElement
}

export function button(el: Pick<TableElements, 'Button'>, props: ButtonProps): RenderElement {
  return h(el.Button, props) as RenderElement
}

export function link(el: Pick<TableElements, 'Link'>, props: LinkProps, ...children: RenderChildren[]): RenderElement {
  return h(el.Link, props, ...children) as RenderElement
}

/** Source with the engine's highlighter: colored tokens, a gutter from `startLine`, or a unified diff under `format: 'diff'`. A leaf. */
export function code(el: Pick<TableElements, 'Code'>, props: CodeProps): RenderElement {
  return h(el.Code, props) as RenderElement
}

/** A block of Markdown, drawn as the engine draws a reply. A leaf. */
export function markdown(el: Pick<TableElements, 'Markdown'>, props: MarkdownProps): RenderElement {
  return h(el.Markdown, props) as RenderElement
}
