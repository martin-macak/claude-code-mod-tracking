// No $ in this file. The runner is injected.
export type RunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
export type Run = (argv: readonly string[], init?: RunInit) => Promise<RunResult>

/** Cheap detection: run `<name> --version` once, cache the promise. */
export class Availability {
  private cache = new Map<string, Promise<boolean>>()
  constructor(private readonly run: Run) {}
  has(name: string): Promise<boolean> {
    let p = this.cache.get(name)
    if (!p) {
      p = this.run([name, '--version'], { timeoutMs: 5000 }).then((r) => r.exitCode === 0, () => false)
      this.cache.set(name, p)
    }
    return p
  }
}

export type Parsed = { host: string; owner: string; repo: string } | null
/** owner/repo from a git remote URL: scp-like, ssh://, https://, git://. */
export function parseRemote(remote: string | null | undefined): Parsed {
  if (!remote) return null
  const m =
    /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote) ??
    /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote)
  return m ? { host: m[1]!, owner: m[2]!, repo: m[3]! } : null
}
