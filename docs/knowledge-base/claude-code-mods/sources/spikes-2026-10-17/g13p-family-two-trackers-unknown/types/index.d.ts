// ONE family key for every tracker. A new tracker adds no key here.
export type G13Slice = unknown

declare module 'claude-code' {
  interface PluginState {
    g13: {
      slots: StateFamily<G13Slice>
    }
  }
}
