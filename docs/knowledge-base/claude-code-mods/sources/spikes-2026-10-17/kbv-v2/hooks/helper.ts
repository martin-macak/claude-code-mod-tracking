import type { EngineInterface } from 'claude-code'
export async function probe($: EngineInterface) { return $.process.run(['gh', '--version']) }
