export type G02Count = number

declare module 'claude-code' {
  interface PluginState {
    'g02-ports-object': {
      count: G02Count
    }
  }
}
