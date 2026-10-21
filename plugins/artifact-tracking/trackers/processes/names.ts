// The display name of a process row. The stored name and the fingerprint stay as the parser made them: the probe
// matches on the fingerprint. The view shows a path under the session root from `./`, so a `$PWD` that expanded to a long
// path does not push the rest of the command out of the Name cell (issue #49). A path under the home folder shows from
// `~/` (issue #145). Pure.

import { normalizePath } from '../../core/lib/paths'

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `name` with each word that starts with `<folder>/` shown from `shown`. A word starts after a space, a quote, `=` or
 * `(`, so `--config=/work/x.json` shortens and `x/work/a` does not. A look-alike folder (`/workshop`) and the folder alone
 * stay. No folder, and a folder root (`/` or `C:/`), change nothing. A drive-letter folder (`C:\work`) and a UNC folder
 * (`\\host\share\work`) are Windows folders: their folders may be written with `\` or `/`, in the folder and in the
 * name. A UNC folder starts with two separators, in the name too. On any other folder a `\` is part of a name.
 */
function shorten(name: string, folder: string | undefined, shown: string): string {
  const top = folder ? normalizePath(folder).replace(/\/+$/, '') : ''
  if (top === '' || /^[A-Za-z]:$/.test(top)) return name
  const unc = /^[\\/]{2}[^\\/]/.test(folder ?? '') // `normalizePath` folds the two separators into one
  const sep = unc || /^[A-Za-z]:/.test(top) ? '[\\\\/]' : '/'
  const path = (unc ? sep : '') + top.split('/').map(escaped).join(sep)
  return name.replace(new RegExp(`(^|[\\s"'=(])${path}${sep}`, 'g'), `$1${shown}`)
}

/** `name` with each word under the session root shown from `./`. */
export const fromRoot = (name: string, root: string | undefined): string => shorten(name, root, './')

/** `name` with each word under the home folder shown from `~/`. */
export const fromHome = (name: string, home: string | undefined): string => shorten(name, home, '~/')

/**
 * The name a process row shows. The root goes first, so a word under the root shows from `./` whatever the home folder
 * is (a project in the home folder, or a root above it). What is left of the home folder shows from `~/`.
 */
export const displayName = (name: string, root: string | undefined, home: string | undefined): string =>
  fromHome(fromRoot(name, root), home)
