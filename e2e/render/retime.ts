import { stripAnsi } from '../support/ansi.ts'
import type { Phase, TimelineEvent } from '../support/timeline.ts'
import type { Cast, CastEvent } from './cast.ts'

export type RetimeOptions = { fastSeconds: number }
export type Segment = { start: number; end: number; phase: Phase }

const round = (seconds: number): number => Math.round(seconds * 1e6) / 1e6

// Cast time of the first output that shows the nonce. A short tail of the previous output
// catches a nonce that tmux wrote in two chunks.
export function findSync(cast: Cast, nonce: string): number {
  let tail = ''
  for (const [t, code, data] of cast.events) {
    if (code !== 'o') continue
    const text = tail + stripAnsi(data)
    if (text.includes(nonce)) return t
    tail = text.slice(-(nonce.length - 1))
  }
  throw new Error(`retime: sync nonce ${nonce} not found in the cast`)
}

// Phase spans on the cast clock. Time before the first phase event is cut.
export function segments(timeline: TimelineEvent[], offset: number, castEnd: number): Segment[] {
  const result: Segment[] = []
  let start = 0
  let phase: Phase = 'cut'
  for (const event of timeline) {
    if (event.kind !== 'phase') continue
    const t = Math.max(0, event.t / 1000 + offset)
    if (t > start) result.push({ start, end: t, phase })
    start = Math.max(start, t)
    phase = event.phase
  }
  result.push({ start, end: Math.max(start, castEnd), phase })
  return result
}

function timeMap(spans: Segment[], opts: RetimeOptions): (t: number) => number {
  let acc = 0
  const mapped = spans.map(span => {
    const length = span.end - span.start
    const newLength = span.phase === 'cut' ? 0 : span.phase === 'fast' ? Math.min(length, opts.fastSeconds) : length
    const entry = { span, newStart: acc, scale: length === 0 ? 0 : newLength / length }
    acc += newLength
    return entry
  })
  return t => {
    const hit = mapped.find(m => t <= m.span.end) ?? mapped.at(-1)
    if (hit === undefined) return t
    return hit.newStart + (Math.max(t, hit.span.start) - hit.span.start) * hit.scale
  }
}

export function retime(cast: Cast, timeline: TimelineEvent[], opts: RetimeOptions): Cast {
  const sync = timeline.find(e => e.kind === 'sync')
  if (sync === undefined || sync.kind !== 'sync') throw new Error('retime: the timeline has no sync event')
  const offset = findSync(cast, sync.nonce) - sync.t / 1000
  const end = timeline.find(e => e.kind === 'end')
  const kept = end === undefined ? cast.events : cast.events.filter(([t]) => t < end.t / 1000 + offset)
  const castEnd = kept.at(-1)?.[0] ?? 0
  const map = timeMap(segments(timeline, offset, castEnd), opts)
  let last = 0
  const events = kept.map(([t, code, data]): CastEvent => {
    last = Math.max(last, round(map(t)))
    return [last, code, data]
  })
  return { header: cast.header, events }
}
