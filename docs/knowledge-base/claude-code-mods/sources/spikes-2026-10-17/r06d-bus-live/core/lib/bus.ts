import type { SessionAppendDoor } from 'claude-code'

export type Decl = { id: string; doors: readonly SessionAppendDoor[]; tools: readonly string[] }
export const doorsOf = (ts: readonly Decl[]): SessionAppendDoor[] => [...new Set(ts.flatMap(t => t.doors))]
/** tool name -> ids of the trackers that declared it (the Map the tool.call hook dispatches on) */
export const toolMap = (ts: readonly Decl[]): Map<string, string[]> => {
  const m = new Map<string, string[]>()
  for (const t of ts) for (const tool of t.tools) m.set(tool, [...(m.get(tool) ?? []), t.id])
  return m
}
