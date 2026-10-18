export type Slot = { n: number }

declare module 'claude-code' {
  interface PluginState {
    'lifecycle-mod': {
      marker: string
      slots: StateFamily<Slot>
    }
  }
}
