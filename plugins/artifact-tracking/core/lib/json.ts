// Helpers for untrusted JSON: engine results and tool replies. Pure. One copy for every reader.

export type Json = Record<string, unknown>

export function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Reads `obj.a.b.c`, with array indexes as numbers. undefined when any step is missing. */
export function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur = obj
  for (const step of path) {
    if (typeof step === 'number') cur = Array.isArray(cur) ? cur[step] : undefined
    else cur = isRecord(cur) ? cur[step] : undefined
  }
  return cur
}
