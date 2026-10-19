// Narrow ports (ISP). No `$` in this file. A class takes the ports it needs.
export type Run = (
  argv: readonly string[],
  init?: { cwd?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type Ports = {
  state: { get(): Promise<number>; bump(): Promise<number> }
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
  }
  clock: {
    now(): Promise<number>
    after(ms: number, fn: () => void): unknown
    every(ms: number, fn: () => void): unknown
  }
  run: Run
  session: { id(): Promise<string>; cwd(): Promise<string> }
}
