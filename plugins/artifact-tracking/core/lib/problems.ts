// The cap on the config problems (issue #144). A malformed file gives one problem per bad key, with no limit. The mod
// shows the first `MAX_PROBLEMS` and one count line. The log keeps every problem. Pure: no I/O.

import type { MoreProblems } from '../interfaces/config'

/** How many config problems the mod shows before it counts the rest. */
export const MAX_PROBLEMS = 50

/**
 * The count line: how many problems the list leaves out and where all of them are. The mod writes no log file of its own.
 * Its log port goes to the engine's debug log (`to: 'debug'`), so that log holds every problem, and it exists only when
 * `claude` starts with `--debug` or `--debug-file` (issue #144). `log` is the default place of that log, when the mod can
 * compute one (`resolveDebugLog`). A run with `--debug-file <path>` writes to `<path>` instead. With no `log` the line
 * names the debug log without a path.
 */
export const moreLine = (count: number, log?: string): string =>
  `${count} more ${count === 1 ? 'problem' : 'problems'}: see ${log ?? 'the debug log'} (claude --debug)`

/**
 * The problems as the mod shows them: the first `MAX_PROBLEMS`, then one count line when more exist. `more` holds the
 * count and the count line of the problems the list leaves out, and is undefined when all show. With `more` set the
 * count line is the last entry of `list`. `log` goes to the count line (`moreLine`).
 */
export function capProblems(
  all: readonly string[],
  log?: string,
): { readonly list: readonly string[]; readonly more: MoreProblems | undefined } {
  const count = all.length - MAX_PROBLEMS
  if (count <= 0) return { list: all, more: undefined }
  const line = moreLine(count, log)
  return { list: [...all.slice(0, MAX_PROBLEMS), line], more: { count, line } }
}

/** The problems of a capped list without its count line. A reader that cuts the list further counts `more` itself. */
export const namedProblems = (list: readonly string[], more: MoreProblems | undefined): readonly string[] =>
  more === undefined ? list : list.slice(0, -1)
