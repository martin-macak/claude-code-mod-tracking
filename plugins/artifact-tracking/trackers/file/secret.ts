// The secret rule of the file preview (issue #57, L2; owner decision Q2): the row of a secret file is tracked, because the path is
// already in the transcript, but the preview shows a notice and never reads the file, because its content on a screen is the new
// risk. A fixed rule (`.env`, keys, certificates, the folders of SSH, GnuPG, AWS, Kubernetes and the GitHub CLI) and the globs of
// `trackers.file.secretPaths`. The rule reads the path alone and ignores case. Pure: no `$`, no I/O.
// Design study G3: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787

/** The files that are no secret though their name looks like one: the examples of a project. */
const TEMPLATE = /^\.env\.(example|sample|template)$/

/** The names of secret files, on the lower case base name. A key or certificate by extension, an SSH key by its prefix. */
const BY_NAME: readonly RegExp[] = [
  /^\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|kdbx)$/,
  /^id_(rsa|ed25519|ecdsa)/,
  /^\.(netrc|pgpass|pypirc|npmrc)$/,
]

/**
 * The folders whose files are all secret, as they sit in a lower case path with a slash at both ends. The rule names the folder
 * and not the home folder (`~/.ssh`): a root, another user, a symlinked home and a home that the engine did not say all match.
 */
const FOLDERS: readonly string[] = ['/.ssh/', '/.gnupg/', '/.aws/', '/.kube/', '/.config/gh/']

/** The one file of a folder that is secret: the Docker client keeps its registry tokens there. */
const DOCKER_CONFIG = '/.docker/config.json'

/** A path with forward slashes only: a Windows path is read as a path. */
const slashed = (path: string): string => path.replaceAll('\\', '/')

/** The slashes that end a path. */
const TRAILING_SLASHES = /\/+$/

/** The last segment of a slashed path. */
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * One piece of a glob. `char` is itself. `one` is `?`: one character but a slash. `star` is `*`: any run of characters but a slash.
 * `deep` is a double star: any run at all. `folders` is a double star that is a whole segment and has a slash after it: no folder, or any
 * number of them, so `a/<stars>/b` matches `a/b` too.
 */
type Piece = { readonly kind: 'char'; readonly c: string } | { readonly kind: 'one' | 'star' | 'deep' | 'folders' }

/** A glob as pieces, to match on the path or, with no slash in it, on the base name. `anchored`: the match starts at the very start of the text. */
type Glob = { readonly pieces: readonly Piece[]; readonly onPath: boolean; readonly anchored: boolean }

/**
 * The pieces of a glob, or undefined when it cannot match: a glob that starts with `~/` needs the home folder. A run of two stars or
 * more is one wildcard. The home folder and every other character stand for themselves, case aside.
 */
function globOf(glob: string, home: string | undefined): Glob | undefined {
  let g = slashed(glob).toLowerCase()
  let literal = 0 // the characters of `g` from the home folder: they are no wildcards, whatever the folder is called
  if (g.startsWith('~/')) {
    if (home === undefined || home === '') return undefined
    const folder = `${slashed(home).toLowerCase().replace(TRAILING_SLASHES, '')}/`
    literal = folder.length
    g = `${folder}${g.slice(2)}`
  }
  const pieces: Piece[] = []
  for (let i = 0; i < g.length; ) {
    const c = g[i] as string
    if (i < literal || (c !== '*' && c !== '?')) {
      pieces.push({ kind: 'char', c })
      i++
    } else if (c === '?') {
      pieces.push({ kind: 'one' })
      i++
    } else {
      let end = i
      while (g[end] === '*') end++
      const wholeSegment = (i === 0 || g[i - 1] === '/') && g[end] === '/'
      if (end - i < 2) pieces.push({ kind: 'star' })
      else if (wholeSegment) pieces.push({ kind: 'folders' })
      else pieces.push({ kind: 'deep' })
      i = wholeSegment && end - i >= 2 ? end + 1 : end // the slash of a `folders` piece belongs to it
    }
  }
  const onPath = g.includes('/')
  return { pieces, onPath, anchored: !onPath || g.startsWith('/') }
}

/**
 * True when `glob` matches the whole of `text`. It follows every way to match at once, one piece after another, over the positions of
 * the text that can be reached: the work is the pieces times the length of the text, whatever the stars. A regular expression would
 * try the ways one by one, and a few stars between literals would take seconds on one path, on the one thread of the pane.
 */
function matches({ pieces, anchored }: Glob, text: string): boolean {
  const n = text.length
  let now = new Uint8Array(n + 1)
  // Where a match may start: the start of the text, or (relative glob) after any slash.
  now[0] = 1
  if (!anchored) for (let i = 1; i <= n; i++) if (text[i - 1] === '/') now[i] = 1
  for (const piece of pieces) {
    const next = new Uint8Array(n + 1)
    switch (piece.kind) {
      case 'char':
        for (let i = 0; i < n; i++) if (now[i] === 1 && text[i] === piece.c) next[i + 1] = 1
        break
      case 'one':
        for (let i = 0; i < n; i++) if (now[i] === 1 && text[i] !== '/') next[i + 1] = 1
        break
      case 'star':
        for (let i = 0; i <= n; i++)
          if (now[i] === 1 || (i > 0 && next[i - 1] === 1 && text[i - 1] !== '/')) next[i] = 1
        break
      case 'deep':
        for (let i = 0; i <= n; i++) if (now[i] === 1 || (i > 0 && next[i - 1] === 1)) next[i] = 1
        break
      case 'folders': {
        let reached = false // a position before this one is reached: the folders may end at this slash
        for (let i = 0; i <= n; i++) {
          if (now[i] === 1 || (i > 0 && text[i - 1] === '/' && reached)) next[i] = 1
          if (now[i] === 1) reached = true
        }
        break
      }
      default:
        return piece satisfies never
    }
    now = next
  }
  return now[n] === 1
}

/** True when a glob of the list starts with `~/`: it needs the home folder, and with none the rule cannot say what it hides. */
export const needsHome = (globs: readonly string[]): boolean => globs.some(glob => slashed(glob).startsWith('~/'))

export interface SecretOptions {
  /** `trackers.file.secretPaths`: globs added to the fixed rule. */
  readonly extra?: readonly string[]
  /** `HOME`, for the globs that start with `~/`. */
  readonly home?: string | undefined
}

/**
 * True for a path whose content the preview must not show: the fixed rule, or a glob of `extra`. Call it for each spelling of the
 * file (the path as spelled and the real path): a link with an innocent name may lead to a key.
 */
export function isSecretPath(path: string, { extra = [], home }: SecretOptions = {}): boolean {
  const p = slashed(path).toLowerCase()
  if (p === '') return false
  const base = baseOf(p)
  if (!TEMPLATE.test(base) && BY_NAME.some(rule => rule.test(base))) return true
  if (FOLDERS.some(folder => `/${p}`.includes(folder)) || p.endsWith(DOCKER_CONFIG)) return true
  return extra.some(glob => {
    const found = globOf(glob, home)
    return found !== undefined && matches(found, found.onPath ? p : base)
  })
}
