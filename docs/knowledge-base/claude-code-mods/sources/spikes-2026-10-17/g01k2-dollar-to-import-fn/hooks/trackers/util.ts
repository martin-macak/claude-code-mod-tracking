import type { EngineInterface } from 'claude-code'
export async function nowOf($: EngineInterface): Promise<number> {
  return $.clock.now()
}
