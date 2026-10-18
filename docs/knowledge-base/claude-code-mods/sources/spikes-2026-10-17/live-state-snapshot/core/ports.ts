export type Ports = {
  state: { bump(): Promise<number>; get(): Promise<number> }
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  fs: { read(path: string): Promise<string>; write(path: string, text: string): Promise<void>; exists(path: string): Promise<boolean> }
  clock: { now(): Promise<number>; after(ms: number, fn: () => void): unknown; every(ms: number, fn: () => void): unknown }
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>
  session: { id(): Promise<string>; cwd(): Promise<string> }
}
