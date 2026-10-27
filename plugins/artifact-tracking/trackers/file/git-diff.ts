// The diff mode of the file preview (issue #254, L3 of #57): the working tree against the merge-base of `HEAD` with the base of the PR of the
// session branch (`github.branchPr`), else with `origin/HEAD`. The file is read through `git`, run by argument vector with no shell, in
// the folder of the file, with a pinned set of global options and flags: no external diff or text conversion, no color, no rename
// detection, literal pathspecs. The cases each end in blocks for core to draw: the hunks, or a notice that says why there are none (not a
// repository, no base, no change, a binary file, a diff that is too large). A repo or a base that is not there also turns the diff mode
// off (`diff-off.ts`), and `probeLater` asks for that apart from a hook, when the view opens. Nothing else is stored.
// Design study R15, R16, R17 (diff part), G13, G14: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787

import type { Json } from '../../core/interfaces/items'
import type { FsStat, RunResult } from '../../core/interfaces/ports'
import type { PreviewBlock } from '../../core/interfaces/preview'
import type { FactsPort, TrackerContext } from '../../core/interfaces/tracker'
import { LoadState } from '../../core/lib/load-state'
import { dirName, normalizePath, relativeToRoot } from '../../core/lib/paths'
import { message } from '../../core/lib/text'
import type { FileConfig } from './config'
import { prBaseRefs, refLabel } from './diff-base'
import { clearOff, markOff } from './diff-off'
import { changesOf, cutDiff, hunksOf, isBinaryDiff } from './diff-text'
import { branchesOfFact, FACT_BRANCH_PR, rootOf } from './facts'
import { failureOf, kindOf, notice, sizeText } from './notice'
import type { FileRecord } from './types'

/** A `git` call that hangs on a hung mount or a huge repo must not hold the pane. */
const GIT_TIMEOUT_MS = 5000
/** A diff over this many bytes is a notice: the engine's own panel draws no more (design study G13). */
export const DIFF_MAX_BYTES = 1_000_000

/**
 * The global options of every git call. No optional lock, so a read never blocks a commit. Literal pathspecs: the name of a file with
 * `*` or `[` is one path. `core.quotePath=false` keeps a name with non-ASCII characters as it is. `core.fsmonitor=false` stops a
 * repository from starting a program of its own to answer a read. `diff.relative=false` pins the form of the paths. The argv is the
 * test `tests/file-diff.test.ts` pins.
 */
export const GIT_PIN = [
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.relative=false',
] as const
/** The flags of every diff call, a file that git tracks or not: no program of the repository (external diff, text conversion), no color, no renames, three lines of context. */
export const DIFF_FLAGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-renames',
  '--ignore-submodules=dirty',
  '--unified=3',
] as const

/**
 * Every notice of the diff mode, in the words a person reads: the one place for them (`scripts/contracts/file-docs.test.mjs` builds the
 * check of the README from this table, so a new or a reworded notice fails it until the README says it). A notice that holds a part
 * that changes (a base, a cause, a count) is a function of strings. The parts of the view (a secret, a folder, an image) are in `preview.ts`.
 */
export const DIFF_NOTICES = {
  noRepo: 'Not in a git repository, so there is nothing to diff against.',
  repoRefused: (why: string) => `git could not use the repository: ${why}`,
  foldersGone: 'The file and its folders are gone, so there is no diff.',
  couldNotRun: (why: string) => `Could not run git: ${why}`,
  noOrigin:
    'No base to diff against: origin/HEAD is not set in this repository (git remote set-head origin --auto sets it).',
  unrelated: 'No base to diff against: HEAD and origin/HEAD have no common ancestor.',
  noOriginPr: (base: string) =>
    `No base to diff against: neither the base of the PR (${base}) nor origin/HEAD is in this clone (git fetch origin, then git remote set-head origin --auto).`,
  unrelatedPr: (base: string) =>
    `No base to diff against: HEAD has no common ancestor with the base of the PR (${base}) or with origin/HEAD.`,
  prBaseMissing: (base: string) =>
    `The base of the PR (${base}) is not in this clone, so the diff is against origin/HEAD. Fetch the base branch to diff against the PR.`,
  prBaseOdd: (base: string) =>
    `The base of the PR (${base}) is not a plain branch name, so the diff is against origin/HEAD.`,
  deleted: 'The file is deleted: the diff shows what was removed.',
  diffFailed: (why: string) => `git diff failed: ${why}`,
  lsFilesFailed: (why: string) => `git ls-files failed: ${why}`,
  tooLarge: `The diff is larger than ${DIFF_MAX_BYTES.toLocaleString('en-US')} bytes: the preview does not draw it. Use git diff in a terminal.`,
  binary: (kind: string, size?: string) =>
    `Binary file, ${kind}${size === undefined ? '' : `, ${size}`}. The diff shows text only.`,
  noChange: (base: string) => `No change against ${base}.`,
  modeOnly: (base: string) =>
    `The file changed in a way that has no lines to show (its mode, for example), against ${base}.`,
  goneUntracked: 'The file is gone, and git has no copy of it, so there is no diff.',
  untracked: 'Not tracked by git: the whole file shows as added.',
  untrackedEmpty: 'Not tracked by git, and empty.',
  truncated: (shown: string, total: string, parts: string) =>
    `Truncated: the first ${shown} of ${total} lines of the diff (${parts}).`,
  lineCut: (cap: string) => ` A line is cut short to fit the cap of ${cap} characters.`,
} as const

const sevenOf = (sha: string): string => sha.slice(0, 7)
const hunkWord = (n: number): string => `hunk${n === 1 ? '' : 's'}`

/** What the diff reads of the world: three ports and the clock, so a test passes small fakes. */
type Ctx = Pick<TrackerContext<FileConfig, Json>, 'fs' | 'facts' | 'tools' | 'clock'>

/** What a probe needs: where the file is, and what the stat of it said. */
export interface ProbeInput {
  readonly ctx: Ctx
  /** The real path of the file, as the row has it. */
  readonly path: string
  /** What the stat of the file said: `null` for a file that is gone. */
  readonly stat: FsStat | null
}

export interface DiffInput extends ProbeInput {
  /** The row: its type word goes in the notice of a binary file. */
  readonly rec: FileRecord
  /** The caps of the drawing: the lower of the config and the limits of core. */
  readonly caps: { readonly maxLines: number; readonly maxChars: number }
}

export interface DiffOutput {
  readonly blocks: PreviewBlock[]
  /** The parts of the header after the type and the mode: the base and the count of changes. */
  readonly subtitle: string[]
}

const only = (...blocks: PreviewBlock[]): DiffOutput => ({ blocks, subtitle: [] })

type Git = (args: readonly string[]) => Promise<RunResult>

/** A notice that says why the diff mode has no diff in this folder, and turns the mode off there, with those words as the reason. */
function offNotice(i: ProbeInput, text: string, tone: 'info' | 'warning' = 'info'): PreviewBlock {
  markOff(i.ctx.facts, dirName(i.path), text, i.ctx.clock.wall())
  return notice(text, tone)
}

/** The nearest folder of `path` that is there, for a file that is gone. `undefined`: none, up to the root. */
async function folderOf(i: ProbeInput): Promise<string | undefined> {
  let dir = dirName(i.path)
  if (i.stat !== null) return dir
  for (let depth = 0; depth < 64 && dir !== ''; depth++) {
    if ((await i.ctx.fs.stat(dir))?.kind === 'dir') return dir
    const up = dirName(dir)
    if (up === dir) return undefined
    dir = up
  }
  return undefined
}

/** The top of the session repo, as the auto tracker pins it: `undefined` when it is not known, or the session is in no repo. */
function sessionTop(facts: Pick<FactsPort, 'read'>): string | undefined {
  const top = rootOf(facts).top
  return top === undefined ? undefined : normalizePath(top)
}

/** One answer of `merge-base`: the commit, or why there is none. `missing`: the ref is not in the clone. `unrelated`: no common ancestor. */
type Mergeable = { sha: string } | { missing: true } | { unrelated: true }

/**
 * Where the diff of a file starts, or why it cannot: the repo of the folder, and the base in it. The answer is kept for `modes()` as the
 * diff mode of this folder: off, with the words of the notice, when there is no diff to draw, and on again when a base is found. The
 * notices of the PR (its base is not in this clone, or is no plain name) come with a base that is found.
 */
interface Located {
  readonly git: Git
  /** The path of the file from the folder that git runs in. */
  readonly rel: string
  readonly base: { readonly ref: string; readonly sha: string }
  readonly label: string
  readonly notes: readonly PreviewBlock[]
}

async function locate(i: ProbeInput): Promise<{ off: PreviewBlock } | Located> {
  const { ctx } = i
  const cwd = await folderOf(i)
  if (cwd === undefined) return { off: offNotice(i, DIFF_NOTICES.foldersGone) }
  const git: Git = args =>
    ctx.tools.run('git', ['git', ...GIT_PIN, ...args], { cwd, env: { LC_ALL: 'C' }, timeoutMs: GIT_TIMEOUT_MS })

  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0 || top.stdout.trim() === '') {
    const text =
      /not a git repository/i.test(top.stderr) || top.exitCode === 0
        ? DIFF_NOTICES.noRepo
        : DIFF_NOTICES.repoRefused(failureOf(top.stderr, top.exitCode))
    return { off: offNotice(i, text) }
  }
  const repo = normalizePath(top.stdout.trim())

  // The base of the PR of the session branch applies to the session repo only, and only while the repo is on the head of that PR: a
  // fact that a branch switch left behind is not used. Nothing proves the repo without a root that the auto tracker pinned.
  const pr = branchesOfFact(ctx.facts.read<Json>(FACT_BRANCH_PR))
  let applies = false
  if (pr !== undefined && sessionTop(ctx.facts) === repo) {
    const head = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
    applies = head.exitCode === 0 && head.stdout.trim() === pr.head
  }
  const prRefs = applies && pr !== undefined ? prBaseRefs(pr.base) : []

  const base = await findBase(git, prRefs)
  if ('failure' in base) {
    return { off: offNotice(i, noBase(base.failure, prRefs.length > 0 ? pr?.base : undefined)) }
  }
  clearOff(ctx.facts, dirName(i.path))
  const notes: PreviewBlock[] = []
  if (applies && pr !== undefined) {
    if (prRefs.length === 0) notes.push(notice(DIFF_NOTICES.prBaseOdd(pr.base)))
    else if (base.ref === 'origin/HEAD') notes.push(notice(DIFF_NOTICES.prBaseMissing(pr.base)))
  }
  return {
    git,
    rel: relativeToRoot(i.path, cwd),
    base,
    label: `${refLabel(base.ref)} @ ${sevenOf(base.sha)}`,
    notes,
  }
}

/** The diff of one file. A git that cannot start, or that runs out of time, is a warning notice, and the mode is off then. */
export async function loadDiff(i: DiffInput): Promise<DiffOutput> {
  try {
    return await diffOf(i)
  } catch (e) {
    return only(offNotice(i, DIFF_NOTICES.couldNotRun(message(e)), 'warning'))
  }
}

async function diffOf(i: DiffInput): Promise<DiffOutput> {
  const found = await locate(i)
  if ('off' in found) return only(found.off)
  const { git, rel, base, label } = found
  const notes = [...(i.stat === null ? [notice(DIFF_NOTICES.deleted)] : []), ...found.notes]

  const out = await git(['diff', ...DIFF_FLAGS, base.sha, '--', rel])
  if (out.exitCode !== 0) return only(notice(DIFF_NOTICES.diffFailed(failureOf(out.stderr, out.exitCode)), 'warning'))
  if (tooLarge(out)) return only(notice(DIFF_NOTICES.tooLarge))
  const hunks = hunksOf(out.stdout)
  if (hunks !== undefined) return shown(i, notes, hunks, [`vs ${label}`])
  if (isBinaryDiff(out.stdout)) {
    // A file that is gone has no size on disk: the commit that the diff starts at has its last copy.
    const size = i.stat?.size ?? (await sizeAt(git, base.sha, rel))
    return only(...notes, notice(DIFF_NOTICES.binary(kindOf(i.rec), size === undefined ? undefined : sizeText(size))))
  }

  // Nothing came out. Tracked and unchanged, or not tracked at all (a diff against a commit shows no file that git does not know).
  const known = await git(['ls-files', '--error-unmatch', '--', rel])
  if (known.exitCode === 0) {
    return only(
      ...notes,
      notice(out.stdout.trim() === '' ? DIFF_NOTICES.noChange(label) : DIFF_NOTICES.modeOnly(label)),
    )
  }
  if (known.exitCode !== 1) {
    return only(notice(DIFF_NOTICES.lsFilesFailed(failureOf(known.stderr, known.exitCode)), 'warning'))
  }
  if (i.stat === null) return only(notice(DIFF_NOTICES.goneUntracked))
  const added = await git(['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', rel])
  // Exit 1 is the result of `--no-index`: the two sides differ.
  if (added.exitCode > 1) {
    return only(notice(DIFF_NOTICES.diffFailed(failureOf(added.stderr, added.exitCode)), 'warning'))
  }
  if (tooLarge(added)) return only(notice(DIFF_NOTICES.tooLarge))
  const lines = hunksOf(added.stdout)
  if (lines !== undefined) return shown(i, [notice(DIFF_NOTICES.untracked)], lines, ['new file'])
  if (isBinaryDiff(added.stdout)) {
    return only(notice(DIFF_NOTICES.binary(kindOf(i.rec), sizeText(i.stat.size))))
  }
  return only(notice(DIFF_NOTICES.untrackedEmpty))
}

/** The size of the file `rel` in the commit `sha`, read by `git cat-file -s`; `undefined` when git cannot say. `./` makes the path relative to the folder git runs in. */
async function sizeAt(git: Git, sha: string, rel: string): Promise<number | undefined> {
  const r = await git(['cat-file', '-s', `${sha}:./${rel}`])
  const n = Number(r.stdout.trim())
  return r.exitCode === 0 && Number.isInteger(n) && n >= 0 ? n : undefined
}

/** Why no base was found. `prBase`: the base branch of the PR that was tried first. */
function noBase(failure: 'missing' | 'unrelated', prBase: string | undefined): string {
  if (failure === 'unrelated') {
    return prBase === undefined ? DIFF_NOTICES.unrelated : DIFF_NOTICES.unrelatedPr(prBase)
  }
  return prBase === undefined ? DIFF_NOTICES.noOrigin : DIFF_NOTICES.noOriginPr(prBase)
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length
/**
 * A diff over the limit in bytes, or one that the runner cut. The runner counts UTF-16 units, and a unit is at most three bytes, so a
 * diff of up to a third of the limit in units is under it with no count; a longer one is counted in bytes.
 */
const tooLarge = (out: RunResult): boolean =>
  out.isStdoutTruncated === true || (out.stdout.length * 3 > DIFF_MAX_BYTES && byteLength(out.stdout) > DIFF_MAX_BYTES)

/**
 * The first base that git knows: the refs of the PR in order, then `origin/HEAD`. The merge-base of `HEAD` with it is the commit the
 * diff starts at. A ref that is not in the clone is skipped; `unrelated` is the answer of a base that shares no commit with `HEAD`.
 */
async function findBase(
  git: Git,
  prRefs: readonly string[],
): Promise<{ ref: string; sha: string } | { failure: 'missing' | 'unrelated' }> {
  let failure: 'missing' | 'unrelated' = 'missing'
  for (const ref of [...prRefs, 'origin/HEAD']) {
    const found = await mergeBase(git, ref)
    if ('sha' in found) return { ref, sha: found.sha }
    if ('unrelated' in found) failure = 'unrelated'
  }
  return { failure }
}

async function mergeBase(git: Git, ref: string): Promise<Mergeable> {
  const r = await git(['merge-base', 'HEAD', ref])
  const sha = r.stdout.trim()
  if (r.exitCode === 0 && sha !== '') return { sha }
  return r.exitCode === 1 ? { unrelated: true } : { missing: true }
}

/** The blocks of a diff that has lines: the notices, the notice of a cut, then the hunks cut to the caps. */
function shown(i: DiffInput, notes: readonly PreviewBlock[], hunks: string, head: string[]): DiffOutput {
  const cut = cutDiff(hunks, i.caps.maxLines, i.caps.maxChars)
  const changes = changesOf(hunks)
  const blocks: PreviewBlock[] = [...notes]
  if (cut.cut) {
    const parts = `${cut.shownHunks} of ${cut.totalHunks} ${hunkWord(cut.totalHunks)}${cut.partial ? ', the last one cut' : ''}`
    const truncated = DIFF_NOTICES.truncated(String(cut.shownLines), String(cut.totalLines), parts)
    const line = cut.lineCut ? DIFF_NOTICES.lineCut(String(i.caps.maxChars)) : ''
    const text = truncated + line
    blocks.push(notice(text, 'warning'))
  }
  blocks.push({ kind: 'diff', source: cut.source, path: i.path })
  return { blocks, subtitle: [...head, `+${changes.added} -${changes.removed}`] }
}

/**
 * Asks git whether the folder of the file has a repo and a base, and keeps the answer for `modes()` (`diff-off.ts`). It never rejects:
 * a git that cannot start or runs out of time is an answer too (the mode is off, with those words).
 */
export async function probeDiff(i: ProbeInput): Promise<void> {
  try {
    await locate(i)
  } catch (e) {
    offNotice(i, DIFF_NOTICES.couldNotRun(message(e)), 'warning')
  }
}

/** A probe that was started and has not ended counts for this long; a timer that the engine refused then does not stop the folder for good. */
const PROBE_HOLD_MS = 30_000
/** The folders that have a probe in flight, by load, with the time it was started. */
const probing = new LoadState<Map<string, number>>()

/**
 * Starts `probeDiff` after the hook that asks has returned (`clock.after(0)`, as the type lookup does), so the view runs no git itself and
 * waits for none. One probe for a folder at a time: presses of `v` in a row ask once. Returns at once and never throws.
 */
export function probeLater(i: ProbeInput): void {
  const folder = dirName(i.path)
  const busy = probing.of(i.ctx, () => new Map<string, number>())
  const now = i.ctx.clock.wall()
  const since = busy.get(folder)
  if (since !== undefined && now - since < PROBE_HOLD_MS) return
  busy.set(folder, now)
  try {
    // The engine runs the callback and ignores what it returns; the mini clock of the tests awaits it.
    i.ctx.clock.after(0, (() => probeDiff(i).finally(() => busy.delete(folder))) as () => void)
  } catch {
    busy.delete(folder)
  }
}
