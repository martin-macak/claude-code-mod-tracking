export type G13Slot = { n: number }

declare module 'claude-code' {
  interface PluginState {
    g13: {
      a: number
      slots: StateFamily<G13Slot>
    }
  }
}
