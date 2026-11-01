import { writeProbePlugin } from './probe-plugin.ts'

// A probe plugin that marks the end of a turn on the screen (issue #197, features/turn-strip.feature). A scenario that proves
// the absence of the strip line needs an event that comes after the point where the line would draw. The Stop hook is not
// one: it ends the turn before the `turn.complete` hook of the mod has returned. The engine draws the text that the whole
// chain of `turn.complete` hooks returns as one notice row. The probe adds its mark to that text, so the mark and the strip
// line of the mod, if there is one, are in the same row and draw together. When the screen shows the mark, the line would
// show too: its absence then proves something. The probe adds the mark whatever the mode of the strip is. The mark orders
// the text line only, not the TurnDuration strip of `interactive`, which shows counts and which the strip-off scenario never
// draws. The rule that finds a notice of another plugin (the text differs from the answer) is the rule of `withLine` in
// plugins/artifact-tracking/core/lib/turn-strip.ts, used by the hook in plugins/artifact-tracking/hooks/register.tsx: keep them equal.

/** The words the probe adds to the text of a turn end. The engine puts the name of the plugin in front of them. */
export const TURN_END_MARK = 'e2e turn-end mark'

/** The module of the probe. The mark is in the text, so the probe reads no environment. */
export function turnEndSource(): string {
  return [
    '// Test probe of the e2e harness: adds a mark to the text of a main turn end, under the notice of another plugin if there is one.',
    'export const register = on => {',
    "  on('turn.complete', async ($, e, next) => {",
    '    const out = await next(e)',
    '    if (e.agentId !== undefined) return out',
    "    const below = typeof out.text === 'string' && out.text !== e.answer ? out.text : ''",
    `    const mark = ${JSON.stringify(TURN_END_MARK)}`,
    "    return { ...out, text: below === '' ? mark : below + '\\n' + mark }",
    '  })',
    '}',
    '',
  ].join('\n')
}

/** Writes the probe plugin into `dir`. The probe has no log: its mark is on the screen. */
export function writeTurnEndProbe(dir: string): { readonly pluginDir: string } {
  return writeProbePlugin(dir, {
    name: 'turn-end-probe',
    description: 'e2e probe: marks the end of a main turn on the screen',
    source: turnEndSource,
  })
}
