// Lexical path helpers that more than one tracker needs: what is absolute, a normalized path, and a path below a root.
// Moved out of trackers/file/files.ts in issue #49, so the processes tracker can show a name from `./` without importing
// another tracker. Pure: no I/O, and no symbolic link is followed.

const DRIVE = /^[A-Za-z]:/

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/** Folds `.`, `..`, `//` and backslashes. Lexical only: no symbolic link is followed. */
export function normalizePath(path: string): string {
  const raw = path.replace(/\\/g, '/')
  const drive = DRIVE.exec(raw)?.[0] ?? ''
  const body = raw.slice(drive.length)
  const absolute = body.startsWith('/')
  const out: string[] = []
  for (const part of body.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const base = `${absolute ? '/' : ''}${out.join('/')}`
  if (drive) return `${drive}${base || '/'}`
  return base || (absolute ? '/' : '.')
}

/** The path below `root`, or the path itself when it is not below `root`. */
export function relativeToRoot(path: string, root: string): string {
  const abs = normalizePath(path)
  const top = normalizePath(root)
  const prefix = top.endsWith('/') ? top : `${top}/`
  return abs.startsWith(prefix) && abs.length > prefix.length ? abs.slice(prefix.length) : abs
}
