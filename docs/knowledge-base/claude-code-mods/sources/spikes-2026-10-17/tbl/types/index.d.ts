declare module 'claude-code' {
  interface PluginState {
    'arch-spike-tbl': {
      cfg: { rows: number; titleLen: number; auto: boolean; sticky: boolean; long: boolean }
      selected: string | null
      expanded: Record<string, true>
      lastAction: string
    }
  }
}
