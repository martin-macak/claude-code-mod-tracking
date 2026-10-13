export type DockerProbeState = 'up' | 'exited' | 'unhealthy'

export function dockerStateFromStatus(status: string): DockerProbeState {
  const s = status.toLowerCase()
  if (s.includes('unhealthy')) return 'unhealthy'
  if (s.startsWith('up ')) return 'up'
  return 'exited'
}

export function parseDockerPs(stdout: string): Array<{ id: string; name: string; state: DockerProbeState }> {
  const out: Array<{ id: string; name: string; state: DockerProbeState }> = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [id, name, status] = line.split('\t')
    if (!id || !name || !status) continue
    out.push({ id, name, state: dockerStateFromStatus(status) })
  }
  return out
}

function idMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x === y || x.startsWith(y) || y.startsWith(x)
}

export function dockerEntryMatchesRow(
  entry: { id: string; name: string },
  row: { name: string; containerId?: string },
): boolean {
  if (row.containerId) return idMatches(entry.id, row.containerId)
  return entry.name === row.name
}

export function parseTmuxLs(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(l => /^([^:]+):/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined)
}

export function parseScreenLs(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(l => /\d+\.([^\s(]+)/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined)
}

export function psStillMatches(stdout: string, fingerprint: string): boolean {
  const line = stdout.trim()
  if (!line) return false
  const command = line.replace(/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4}\s+/, '')
  return command.toLowerCase().includes(fingerprint.toLowerCase())
}
