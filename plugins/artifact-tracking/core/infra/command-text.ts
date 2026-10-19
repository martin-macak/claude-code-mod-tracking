// The fixed words of `/track`: the usage line, the argument hint, the `prio` levels and the config problems block.
// Split from commands.ts (spec 12: the next layer that edits a file over the size limit splits it).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Plan: L4 Task 6, L6 Task 12, G14.

export const USAGE = 'Usage: /track [refresh|clear|help|prio <ref> <high|normal|low|auto>]'
/** The argument hint while no tracker declares a sub-command. */
export const CORE_HINT = '[refresh|clear|help|prio <ref> <level>]'
/** `/track prio` levels: `auto` removes the person's mark. */
export const PRIO_WORDS: ReadonlySet<string> = new Set(['high', 'normal', 'low', 'auto'])
/** The subs core answers. A tracker cannot take one of them. */
export const CORE_SUBS: ReadonlySet<string> = new Set(['refresh', 'clear', 'help', 'prio'])

/** How many problems the block names before it counts the rest. */
const SHOWN_PROBLEMS = 10

/**
 * The config problems as a block: a header with the path, then each problem on its own line, indented two spaces. Over
 * ten, the first ten and a count. Empty text when all is well.
 */
export function problemsText(path: string | undefined, problems: readonly string[]): string {
  if (problems.length === 0) return ''
  const rest = problems.length - SHOWN_PROBLEMS
  return [
    path === undefined ? 'Config problems:' : `Config problems in ${path}:`,
    ...problems.slice(0, SHOWN_PROBLEMS).map(p => `  ${p}`),
    ...(rest > 0 ? [`  and ${rest} more ${rest === 1 ? 'problem' : 'problems'}.`] : []),
  ].join('\n')
}
