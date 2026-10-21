// The display name of a process row. The stored name and the fingerprint stay as the parser made them: the probe
// matches on the fingerprint. The view shows a path under the session root from `./`, so a `$PWD` that expanded to a long
// path does not push the rest of the command out of the Name cell (issue #49). Pure.

import { normalizePath } from '../../core/lib/paths'

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `name` with each word that starts with `<root>/` shown from `./`. A word starts after a space, a quote, `=` or `(`, so
 * `--config=/work/x.json` shortens and `x/work/a` does not. A look-alike folder (`/workshop`) and the root alone stay.
 * No root, and a folder root (`/` or `C:/`), change nothing. A drive-letter root is a Windows root: its folders may be
 * written with `\` or `/`, in the root and in the name. On any other root a `\` is part of a name.
 */
export function fromRoot(name: string, root: string | undefined): string {
  const top = root ? normalizePath(root).replace(/\/+$/, '') : ''
  if (top === '' || /^[A-Za-z]:$/.test(top)) return name
  const sep = /^[A-Za-z]:/.test(top) ? '[\\\\/]' : '/'
  const path = top.split('/').map(escaped).join(sep)
  return name.replace(new RegExp(`(^|[\\s"'=(])${path}${sep}`, 'g'), '$1./')
}
