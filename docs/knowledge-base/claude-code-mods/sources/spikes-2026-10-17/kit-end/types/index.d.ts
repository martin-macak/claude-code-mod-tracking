export type Counter = number

declare module 'claude-code' {
  interface PluginState {
    'kit-end': {
      n: Counter
    }
  }
}
