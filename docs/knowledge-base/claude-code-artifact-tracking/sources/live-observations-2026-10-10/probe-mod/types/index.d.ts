export type Entry = { label: string; ok?: boolean; ms?: number; at?: number; name?: string; message?: string; value?: unknown }
export type Row = { id: string; depth: number; title: string; type: string; status: string; href?: string; hasKids?: boolean }
declare module 'claude-code' {
  interface PluginState { probe: { log: Entry[]; ticks: number; rows: Row[]; collapsed: string[] } }
}
