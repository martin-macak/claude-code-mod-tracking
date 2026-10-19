// Typed wrappers over the global `h`. A `ux/` module is `.ts`, so node can load and measure it (spec 7.1).
// `h` takes `Record<string, unknown>`, so tsc cannot check a prop. One bad prop refuses the whole pane, and the
// engine tells the mod nothing. These wrappers type every prop of Box, Text, Button and Link.
import type { BoxProps, ButtonProps, Elements, LinkProps, RenderChildren, RenderElement, TextProps } from 'claude-code'

/** The element table `ui.resolve(e)` hands out, cut to the four tags the pane draws. */
export type TableElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

export function box(el: TableElements, props: BoxProps, ...children: RenderChildren[]): RenderElement {
  return h(el.Box, props, ...children) as RenderElement
}

export function text(el: TableElements, props: TextProps, ...children: RenderChildren[]): RenderElement {
  return h(el.Text, props, ...children) as RenderElement
}

export function button(el: TableElements, props: ButtonProps): RenderElement {
  return h(el.Button, props) as RenderElement
}

export function link(el: TableElements, props: LinkProps, ...children: RenderChildren[]): RenderElement {
  return h(el.Link, props, ...children) as RenderElement
}
