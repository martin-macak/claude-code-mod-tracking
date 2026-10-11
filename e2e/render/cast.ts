// asciicast v2: a JSON header line, then one [time, code, data] line per event. Times are absolute seconds.
export type CastHeader = { version: 2; width: number; height: number; [key: string]: unknown }
export type CastEvent = [time: number, code: string, data: string]
export type Cast = { header: CastHeader; events: CastEvent[] }

function isEvent(value: unknown): value is CastEvent {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string'
  )
}

export function parseCast(text: string): Cast {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const [first, ...rest] = lines
  if (first === undefined) throw new Error('cast: empty file')
  const header = JSON.parse(first) as CastHeader
  if (header.version !== 2) throw new Error(`cast: version ${String(header.version)} is not 2`)
  const events = rest.map((line, i) => {
    const value: unknown = JSON.parse(line)
    if (!isEvent(value)) throw new Error(`cast: bad event on line ${i + 2}`)
    return value
  })
  return { header, events }
}

export function writeCast(cast: Cast): string {
  return [JSON.stringify(cast.header), ...cast.events.map(e => JSON.stringify(e))].join('\n') + '\n'
}
