export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
export type Run = (argv: readonly string[]) => Promise<RunResult>
export abstract class Tool {
  constructor(protected readonly run: Run) {}
  abstract probe(): Promise<boolean>
}
export class GhTool extends Tool {
  async probe(): Promise<boolean> {
    try { return (await this.run(['gh', '--version'])).exitCode === 0 } catch { return false }
  }
}
export abstract class TrackedItem {
  constructor(readonly id: string) {}
  abstract canRefresh(): boolean
  abstract refresh(): Promise<void>
}
export class GhItem extends TrackedItem {
  constructor(id: string, private readonly tool: GhTool) { super(id) }
  canRefresh() { return true }
  async refresh() { await this.tool.probe() }
}
