import { normPath } from '../auto/porcelain'

const STRIPPED = /\/$/

export const lower = (s: string): string => s.toLowerCase()

export function cleanPath(path: string): string {
  return path.replace(STRIPPED, '') || '/'
}

export function isAbs(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~/')
}

export function maybeDir(path: string): string {
  const p = cleanPath(path)
  if (p === '/' || p.endsWith('/')) return normPath(p)
  const tail = p.slice(p.lastIndexOf('/') + 1)
  if (tail === '' || (!tail.includes('.') && !tail.startsWith('.'))) return normPath(p)
  const cut = p.slice(0, p.lastIndexOf('/'))
  return normPath(cut || '/')
}

/** True when `base` is `p` or a parent of `p`. Whole segments only. */
export function within(p: string, base: string): boolean {
  return p === base || p.startsWith(`${base}/`)
}
