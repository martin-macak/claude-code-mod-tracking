export type G14Slot = { n: number }

declare module 'claude-code' {
  interface PluginState {
    g14: {
      slots: StateFamily<G14Slot>
    }
  }
}
