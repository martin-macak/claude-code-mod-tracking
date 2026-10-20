import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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

// Keeps turns short and tool-free, so no permission dialog opens in the recording.
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
  model: string
  signalFile: string
  prompt?: string
  /** Tools the session may use without a permission dialog. Absent: the demo session, which uses no tools. */
  tools?: readonly string[]
  /** Variables for claude only, set through env(1) so they win over the tmux server's own. */
  env?: Readonly<Record<string, string>>
}

export function claudeCommand(spec: LaunchSpec): string {
  const args = [
    'claude',
    '--setting-sources',
    'project',
    '--plugin-dir',
    spec.pluginDir,
    '--model',
    spec.model,
    '--append-system-prompt',
    spec.tools ? TOOLS_SYSTEM_PROMPT : DEMO_SYSTEM_PROMPT,
    // Variadic: it takes every word up to the next flag, so a flag must follow it, never the prompt.
    ...(spec.tools ? ['--allowedTools', spec.tools.join(',')] : []),
    '--settings',
    stopHookSettings(spec.signalFile),
  ]
  if (spec.prompt !== undefined) {
    if (spec.prompt.startsWith('-'))
      throw new Error(`session: a prompt must not start with "-" (a flag): ${spec.prompt}`)
    args.push(spec.prompt)
  }
  const vars = Object.entries(spec.env ?? {}).map(([name, value]) => `${name}=${value}`)
  return (vars.length > 0 ? ['env', ...vars, ...args] : args).map(shellQuote).join(' ')
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

// A fresh clone at a neutral path: no home path on screen, same origin, branch main at our HEAD.
export function prepareClone(repoRoot: string, parent: string): string {
  const clone = join(parent, CLONE_NAME)
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const head = git(['rev-parse', 'HEAD'], repoRoot)
  const origin = git(['remote', 'get-url', 'origin'], repoRoot)
  rmSync(clone, { recursive: true, force: true })
  mkdirSync(parent, { recursive: true })
  git(['clone', '--quiet', '--no-checkout', repoRoot, clone], parent)
  git(['checkout', '--quiet', '-B', 'main', head], clone)
  git(['remote', 'set-url', 'origin', origin], clone)
  return clone
}

/** The local copy that stands in for the origin of a fake GitHub repo. Beside the clone, so teardown can remove both. */
export const FAKE_ORIGIN_NAME = 'fake-origin.git'

/** The refs of a repo, one `<ref> <sha>` per line. Two lists that differ say that a ref moved, appeared or went. */
export function listRefs(repo: string): string {
  return execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
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
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const url = `https://github.com/${o.ownerRepo}.git`
  const bare = join(parent, FAKE_ORIGIN_NAME)
  git(['checkout', '--quiet', '-b', o.branch], clone)
  rmSync(bare, { recursive: true, force: true })
  git(['clone', '--quiet', '--bare', clone, bare], parent)
  git(['remote', 'set-url', 'origin', url], clone)
  git(['config', `url.${bare}.insteadOf`, url], clone)
  return bare
}

// The key that moves the trust dialog toward "Yes, I trust this folder", or undefined when no dialog shows.
export function trustKey(screen: string): 'Down' | 'Enter' | undefined {
  if (!TRUST_MARKERS.some(re => re.test(screen))) return undefined
  return TRUST_CHOSEN.test(screen) ? 'Enter' : 'Down'
}

export type LaunchContext = {
  tmux: Tmux
  signalFile: string
  pluginDir: string
  model: string
  timeoutMs: number
  tools?: readonly string[]
  env?: Readonly<Record<string, string>>
}

// Starts claude in the pane. In the trust dialog it moves to "Yes" before Enter. Ends when the
// prompt box is idle, or, with a first prompt, when that turn ends.
export async function launchClaude(ctx: LaunchContext, prompt?: string): Promise<void> {
  const before = countLines(ctx.signalFile)
  const { pluginDir, model, signalFile, tools, env } = ctx
  ctx.tmux.respawn(
    claudeCommand({ pluginDir, model, signalFile, prompt, ...(tools ? { tools } : {}), ...(env ? { env } : {}) }),
  )
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
