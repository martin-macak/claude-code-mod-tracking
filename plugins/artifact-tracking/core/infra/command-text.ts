// The fixed words of `/track`: the usage line, the argument hint, the `prio` levels, the version line and the config
// problems block.
// Split from commands.ts (spec 12: the next layer that edits a file over the size limit splits it).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Plan: L4 Task 6, L6 Task 12, G14.

import type { MoreProblems } from '../interfaces/config'
import { VIEW_IDS } from '../lib/grouping'
import { namedProblems } from '../lib/problems'
import { UNKNOWN } from './manifest'

/** The toast when the terminal has no room for the pane. */
export const NO_ROOM = 'Widen the terminal to see the tracking pane'

/** The reply of `/track` and the toast of the plan key (issue #199) while the item host has not started. */
export const NOT_READY = 'artifact-tracking: not ready.'

export const USAGE =
  'Usage: /track [refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <high|normal|low|auto>]'
/** The argument hint while no tracker declares a sub-command. */
export const CORE_HINT =
  '[refresh|clear|help|version|show-all|view <name>|clean [--hide|--log|--yes <kind>]|turn [n]|prio <ref> <level>]'
/** `/track prio` levels: `auto` removes the person's mark. */
export const PRIO_WORDS: ReadonlySet<string> = new Set(['high', 'normal', 'low', 'auto'])
/** The subs core answers. A tracker cannot take one of them. */
export const CORE_SUBS: ReadonlySet<string> = new Set([
  'refresh',
  'clear',
  'help',
  'version',
  'show-all',
  'view',
  'clean',
  'turn',
  'prio',
])

/** The reply of `/track view` with no name, or a name that is no view (issue #63, L3). */
export const VIEW_USAGE = `Usage: /track view <${VIEW_IDS.join('|')}>`

/** The reply of `/track version`: the name and the version of the mod, so a bug report can quote one line. */
export const versionText = (version: string | undefined): string => `artifact-tracking ${version ?? UNKNOWN}`

/** How many problems the block names before it counts the rest. */
const SHOWN_PROBLEMS = 10

/**
 * The config problems as a block: a header with the path, then each problem on its own line, indented two spaces. Over
 * ten, the first ten and a count that points to `/track help`. Empty text when all is well. `problems` is the list of
 * `ConfigSource.problems()`. The config keeps the first 50 and ends the list with a count line (issue #144). `more` is
 * what it left out: the block drops the count line and counts those problems with the ones it cuts itself.
 */
export function problemsText(path: string | undefined, problems: readonly string[], more?: MoreProblems): string {
  const named = namedProblems(problems, more)
  if (named.length === 0) return ''
  const rest = named.length - SHOWN_PROBLEMS + (more?.count ?? 0)
  return [
    path === undefined ? 'Config problems:' : `Config problems in ${path}:`,
    ...named.slice(0, SHOWN_PROBLEMS).map(p => `  ${p}`),
    ...(rest > 0 ? [`  and ${rest} more ${rest === 1 ? 'problem' : 'problems'}: see /track help.`] : []),
  ].join('\n')
}

/**
 * `--send` as a whole word, in any case, before or after the other words: the person asks for the whole text on purpose
 * (issue #246). The router takes it off the arguments of a sub that has a `screen` spec. `rest` is the other words, one space
 * apart. A word that only starts with `--send` is no `--send`.
 */
export function takeSend(args: string): { send: boolean; rest: string } {
  const words = args.split(/\s+/).filter(w => w !== '')
  const rest = words.filter(w => w.toLowerCase() !== '--send')
  return { send: rest.length !== words.length, rest: rest.join(' ') }
}
