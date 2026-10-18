export type LiveProbeSlice = unknown

declare module 'claude-code' {
  interface PluginState {
    'live-probe': {
      slots: StateFamily<LiveProbeSlice>
      hits: number
    }
  }
}
