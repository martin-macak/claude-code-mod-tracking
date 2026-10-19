export type G02Count = number

declare module 'claude-code' {
  interface PluginState {
    'g02b-ports-factory-in-import': {
      count: G02Count
    }
  }
}
