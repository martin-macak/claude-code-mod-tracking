export type G13Base = number

declare module 'claude-code' {
  interface PluginState {
    g13: { a: G13Base }
  }
}
