import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLONE_NAME } from './config.ts'
import { parseOwnerRepo } from './fake-gh.ts'
import type { Tmux } from './tmux.ts'
import { waitUntil } from './wait.ts'

// Screen text of Claude Code 2.1.296. After an upgrade, check it with `node bin/drive.ts start` and `screen`.
// The trust dialog lists "No, exit" first and selects it, so Enter alone quits.
export const TRUST_MARKERS = [/Yes, I trust this folder/]
export const TRUST_CHOSEN = /❯\sYes, I trust this folder/
// The prompt box line starts at column 0, then a no-break space. Dialog options are indented.
export const READY_MARKERS = [/^❯\s/m]
export const PERMISSION_MARKERS = [/do you want to (proceed|make this edit|create)/i]

// Keeps turns short. The flags `--tools ''` and `--strict-mcp-config` (see `claudeCommand`) keep them tool-free, so no
// permission dialog opens in the recording. This sentence alone did not: a prompt that asks for git or gh work wins over it now and then.
export const DEMO_SYSTEM_PROMPT =
  'This session is recorded for a short product demo. Answer in one short sentence. Do not use any tools.'
// For a scenario that must use tools: no questions, no detours.
export const TOOLS_SYSTEM_PROMPT =
  'This session is an automated end-to-end test. Do exactly what the prompt asks, with as few tool calls as you can. ' +
  'Never ask a question. Answer in one short sentence.'

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

export function stopHookSettings(signalFile: string): string {
  const command = `echo stop >> ${shellQuote(signalFile)}`
  return JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } })
}

export type LaunchSpec = {
  pluginDir: string
  /** More plugins, each with a `--plugin-dir` of its own after the mod: a probe of a scenario. */
  extraPluginDirs?: readonly string[]
  /** The file that claude writes its debug log to (`--debug-file`): the lines a mod writes with `$.ui.log(…, { to: 'debug' })`. */
  debugFile?: string
  model: string
  signalFile: string
  prompt?: string
  /**
   * Tools the session may use without a permission dialog. Absent: the demo session, which has no tool at all (no
   * built-in tool by `--tools ''`, no MCP server by `--strict-mcp-config`), so it can run no command, whatever its
   * prompt asks and whatever permission mode the machine has.
   */
  tools?: readonly string[]
  /** Variables for claude only, set through env(1) so they win over the tmux server's own. */
  env?: Readonly<Record<string, string>>
  /** Variables claude must not inherit: env(1) `-u` removes them before it sets `env`. */
  unset?: readonly string[]
}

export function claudeCommand(spec: LaunchSpec): string {
  const args = [
    'claude',
    '--setting-sources',
    'project',
    '--plugin-dir',
    spec.pluginDir,
    ...(spec.extraPluginDirs ?? []).flatMap(dir => ['--plugin-dir', dir]),
    ...(spec.debugFile === undefined ? [] : ['--debug-file', spec.debugFile]),
    '--model',
    spec.model,
    '--append-system-prompt',
    spec.tools ? TOOLS_SYSTEM_PROMPT : DEMO_SYSTEM_PROMPT,
    // Variadic: it takes every word up to the next flag, so a flag must follow it, never the prompt.
    // A scenario with tools gets the default set and an allow list that spares the dialog. Any other gets no tool:
    // `--tools ''` drops the built-in tools, `--strict-mcp-config` the MCP servers of the account (the repo has none).
    ...(spec.tools ? ['--allowedTools', spec.tools.join(',')] : ['--tools', '', '--strict-mcp-config']),
    '--settings',
    stopHookSettings(spec.signalFile),
  ]
  if (spec.prompt !== undefined) {
    if (spec.prompt.startsWith('-'))
      throw new Error(`session: a prompt must not start with "-" (a flag): ${spec.prompt}`)
    args.push(spec.prompt)
  }
  const vars = Object.entries(spec.env ?? {}).map(([name, value]) => `${name}=${value}`)
  const unset = (spec.unset ?? []).flatMap(name => ['-u', name])
  return (vars.length > 0 || unset.length > 0 ? ['env', ...unset, ...vars, ...args] : args).map(shellQuote).join(' ')
}

export function countLines(file: string): number {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
}

export async function waitForTurnEnd(
  signalFile: string,
  before: number,
  timeoutMs: number,
  last?: () => string,
): Promise<void> {
  await waitUntil(() => (countLines(signalFile) > before ? true : undefined), { timeoutMs, what: 'turn end', last })
}

/** Runs git in `cwd` and gives its trimmed output. Each `config` entry is a `-c` option: a commit needs an author. */
function gitIn(cwd: string, args: readonly string[], config: readonly string[] = []): string {
  return execFileSync('git', [...config.flatMap(c => ['-c', c]), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

// A fresh clone at a neutral path: no home path on screen, same origin, branch main at our HEAD.
export function prepareClone(repoRoot: string, parent: string): string {
  const clone = join(parent, CLONE_NAME)
  const head = gitIn(repoRoot, ['rev-parse', 'HEAD'])
  const origin = gitIn(repoRoot, ['remote', 'get-url', 'origin'])
  rmSync(clone, { recursive: true, force: true })
  mkdirSync(parent, { recursive: true })
  gitIn(parent, ['clone', '--quiet', '--no-checkout', repoRoot, clone])
  gitIn(clone, ['checkout', '--quiet', '-B', 'main', head])
  gitIn(clone, ['remote', 'set-url', 'origin', origin])
  return clone
}

/**
 * Gives a clone from `prepareClone` an `origin/HEAD` at its own HEAD, as the clone of a repo on a branch has. `git clone` sets
 * `origin/HEAD` only when the source is on a branch (or detached at the tip of its default branch). From a checkout that is detached
 * anywhere else (a rebase in progress, a bisect, the merge ref of a CI run) the clone has none, and the diff mode of the preview says
 * that it has no base. The scenarios of that mode pin the base, so they do not depend on how the harness was started.
 */
export function pinOriginHead(clone: string): void {
  const head = gitIn(clone, ['rev-parse', 'HEAD'])
  gitIn(clone, ['update-ref', 'refs/remotes/origin/main', head])
  gitIn(clone, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
}

/** The local copy that stands in for the origin of a fake GitHub repo. Beside the clone, so teardown can remove both. */
export const FAKE_ORIGIN_NAME = 'fake-origin.git'

/** The refs of a repo, one `<ref> <sha>` per line. Two lists that differ say that a ref moved, appeared or went. */
export function listRefs(repo: string): string {
  return gitIn(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])
}

/**
 * Turns a clone from prepareClone into the clone of a fake GitHub repo, on a feature branch (PR discovery drops the
 * default branch). `origin` keeps a github.com URL that names `ownerRepo`, which is where the mod reads the repo from.
 * Git rewrites that URL to a bare copy of the clone (`url.<copy>.insteadOf`), so a fetch or a push, by the mod or by a
 * session that obeys a prompt, reaches the copy and never GitHub. Returns the path of the copy.
 *
 * The scenarios lean on one fact about the engine. The PR lane gets the repo from `session.repo()`, which reads the URL
 * in the git config (verified live, Claude Code 2.1.304). `git remote get-url origin` returns the copy instead: the
 * repos tracker reads it that way, so it sees a local path. If a Claude Code release reads the remote with `get-url`,
 * discovery stops and the chip scenario fails at the chip step: check this first.
 */
export function fakeGithubClone(clone: string, parent: string, o: { branch: string; ownerRepo: string }): string {
  parseOwnerRepo(o.ownerRepo)
  const url = `https://github.com/${o.ownerRepo}.git`
  const bare = join(parent, FAKE_ORIGIN_NAME)
  gitIn(clone, ['checkout', '--quiet', '-b', o.branch])
  rmSync(bare, { recursive: true, force: true })
  gitIn(parent, ['clone', '--quiet', '--bare', clone, bare])
  gitIn(clone, ['remote', 'set-url', 'origin', url])
  gitIn(clone, ['config', `url.${bare}.insteadOf`, url])
  return bare
}

/** What the README of a foreign repo says: the scenario asserts that the fake model read it. */
export const FOREIGN_README = 'Notes of the second repo.\n'

/**
 * A second repo for a scenario of the PR lane (issue #195): a repo the session reads from but did not start in, on a feature
 * branch. It is made in `base/<repo>` with one commit and a README, from nothing: it clones no repo. `origin` is the GitHub
 * URL that names `ownerRepo`, which is where the repos tracker reads the repo from (`git remote get-url origin`). A rewrite
 * for pushes only (`url.<copy>.pushInsteadOf`) sends a push to a bare copy beside it, so nothing the session runs can reach
 * GitHub by a push. `insteadOf` would be wrong here: `get-url` would then give the copy, a local path, and no GitHub repo. The
 * scenario never fetches it (the mod never does). A second call starts afresh.
 *
 * `base` must not be a temporary folder or one of Claude's own: the repos tracker treats those as noise and makes no row of
 * a repo in them (`isNoisePath`). Returns the work tree, its README and the bare copy.
 */
export function fakeForeignRepo(
  base: string,
  o: { branch: string; ownerRepo: string },
): { dir: string; readme: string; bare: string } {
  const { repo } = parseOwnerRepo(o.ownerRepo)
  const dir = join(base, repo)
  const bare = join(base, `${repo}.git`)
  const readme = join(dir, 'README.md')
  const git = (cwd: string, args: string[]) =>
    gitIn(cwd, args, ['user.email=e2e@example.com', 'user.name=e2e', 'commit.gpgsign=false'])
  rmSync(dir, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(readme, FOREIGN_README)
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'Add the README'])
  git(dir, ['checkout', '-q', '-b', o.branch])
  git(base, ['clone', '-q', '--bare', dir, bare])
  const url = `https://github.com/${o.ownerRepo}.git`
  git(dir, ['remote', 'add', 'origin', url])
  git(dir, ['config', `url.${bare}.pushInsteadOf`, url])
  return { dir, readme, bare }
}

// The key that moves the trust dialog toward "Yes, I trust this folder", or undefined when no dialog shows.
export function trustKey(screen: string): 'Down' | 'Enter' | undefined {
  if (!TRUST_MARKERS.some(re => re.test(screen))) return undefined
  return TRUST_CHOSEN.test(screen) ? 'Enter' : 'Down'
}

/** The launch of a session: the spec of the command, and what the launch needs besides: the pane and the time to wait. */
export type LaunchContext = LaunchSpec & {
  tmux: Tmux
  timeoutMs: number
}

/** The command that starts claude for `ctx`: every field of the spec reaches it, whatever fields the spec gets later. */
export function launchCommand(ctx: LaunchContext, prompt?: string): string {
  const { tmux: _tmux, timeoutMs: _timeoutMs, ...spec } = ctx
  return claudeCommand({ ...spec, prompt })
}

// Starts claude in the pane. In the trust dialog it moves to "Yes" before Enter. Ends when the
// prompt box is idle, or, with a first prompt, when that turn ends.
export async function launchClaude(ctx: LaunchContext, prompt?: string): Promise<void> {
  const before = countLines(ctx.signalFile)
  ctx.tmux.respawn(launchCommand(ctx, prompt))
  await waitUntil(
    () => {
      const screen = ctx.tmux.capture()
      const key = trustKey(screen)
      if (key !== undefined) {
        ctx.tmux.key(key)
        return undefined
      }
      if (prompt !== undefined) return countLines(ctx.signalFile) > before ? true : undefined
      return READY_MARKERS.some(re => re.test(screen)) ? true : undefined
    },
    { timeoutMs: ctx.timeoutMs, what: 'claude to start', last: () => ctx.tmux.capture() },
  )
}
