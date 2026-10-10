// State contract for the link-capture mod. `validate` reads the literal shape of PluginState.
export type Via = 'inline' | 'autolink' | 'bare' | 'issue-ref' | 'reference' | 'image' | 'mailto' | 'osc8'

export type Captured = {
  /** Normalized target, as the terminal would receive it. */
  url: string
  /** Visible text of the link when it differs from the URL. */
  label?: string
  /** How the link was written. */
  via: Via
  /** `link`: the renderer or tool made a clickable span. `non-clickable`: it draws plain text. */
  kind: 'link' | 'non-clickable'
  /** True when the scheme is http, https or file. */
  web: boolean
  /** The session.append door of the first sighting. */
  door: string
  /** The row uuid of the first sighting. */
  uuid: string
  /** The subagent that wrote it. Absent on the main conversation. */
  agentId?: string
  /** How many times the same URL was seen. */
  n: number
}

declare module 'claude-code' {
  interface PluginState {
    'link-capture': { links: Captured[]; dropped: number }
  }
}
