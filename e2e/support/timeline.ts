import { appendFileSync, readFileSync } from 'node:fs'

export type Phase = 'cut' | 'fast' | 'normal'
export type TimelineEvent =
  | { t: number; kind: 'sync'; nonce: string }
  | { t: number; kind: 'phase'; phase: Phase }
  | { t: number; kind: 'end' }

const PHASES: readonly string[] = ['cut', 'fast', 'normal']

export const wallClock = (): number => performance.timeOrigin + performance.now()

// Wall-clock marks for the retime step. A phase lasts until the next phase event.
export class Timeline {
  private readonly file: string
  private readonly clock: () => number
  private current: Phase | undefined

  constructor(file: string, clock: () => number = wallClock) {
    this.file = file
    this.clock = clock
  }

  sync(nonce: string): void {
    this.write({ t: this.clock(), kind: 'sync', nonce })
  }

  phase(phase: Phase): void {
    if (phase === this.current) return
    this.current = phase
    this.write({ t: this.clock(), kind: 'phase', phase })
  }

  // The scenario is over. Output after this mark (the tmux detach screen) is not part of the demo.
  end(): void {
    this.write({ t: this.clock(), kind: 'end' })
  }

  private write(event: TimelineEvent): void {
    appendFileSync(this.file, JSON.stringify(event) + '\n')
  }
}

export function parseTimeline(text: string): TimelineEvent[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, i) => {
      const e = JSON.parse(line) as Record<string, unknown>
      if (typeof e.t !== 'number') throw new Error(`timeline: line ${i + 1} has no numeric t`)
      if (e.kind === 'sync' && typeof e.nonce === 'string') return { t: e.t, kind: 'sync', nonce: e.nonce }
      if (e.kind === 'end') return { t: e.t, kind: 'end' }
      if (e.kind === 'phase' && typeof e.phase === 'string' && PHASES.includes(e.phase)) {
        return { t: e.t, kind: 'phase', phase: e.phase as Phase }
      }
      throw new Error(`timeline: line ${i + 1} is not a sync, phase or end event`)
    })
}

export function readTimeline(file: string): TimelineEvent[] {
  return parseTimeline(readFileSync(file, 'utf8'))
}
