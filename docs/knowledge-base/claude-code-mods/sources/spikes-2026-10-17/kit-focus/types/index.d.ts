export type Selected = string | null

declare module 'claude-code' {
  interface PluginState {
    'kit-focus': {
      selected: Selected
      /** Which hook wrote last, so a test can tell. */
      log: string[]
    }
  }
}
