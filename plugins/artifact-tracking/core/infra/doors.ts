// The door rules: which rows carry text that Capture reads, how, and under which source. A door is where an engine row
// came in. The rules are the four hooks of the first design (D3 of the artifact-tracking spec), now one table.
// A replayed row has no real flags (`isMeta`, `origin`): the transcript backfill skips the wrappers it knows.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 8.

import type { RowEvent } from '../interfaces/events'
import type { ScanMode } from '../interfaces/items'
import { commandArgs } from '../lib/links'

/** D3: the person's own text. Never a machine, a notification or a coordinator. */
export const PERSON: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

/** What Capture reads of a row: the text, how to scan it and the source the claims carry. */
export type Reading = { text: string; mode: ScanMode; source: string }

const reading = (text: string, mode: ScanMode, source: string): Reading => ({ text, mode, source })

/**
 * The rules of the four doors that carry text. `prompt`: the person's typed prompt only. `command`: the arguments of the
 * person's slash command (our own `/track` output has origin `engine`). `response`: Claude's text, also a subagent's.
 * `tool-result`: tool output, explicit URLs only.
 */
export const DOORS: Readonly<Record<string, (ev: RowEvent) => Reading | null>> = {
  prompt: ev =>
    PERSON.has(ev.origin) && !ev.isMeta && ev.agentId === undefined ? reading(ev.text, 'full', 'prompt') : null,
  command: ev => (ev.origin === 'composer' ? reading(commandArgs(ev.text), 'full', 'prompt') : null),
  response: ev => reading(ev.text, 'full', 'response'),
  'tool-result': ev => reading(ev.text, 'urls-only', 'tool'),
}

/**
 * Wrappers of user-role rows that the person did not type. A transcript message has no `isMeta` or `origin`, so the
 * backfill can only skip the wrappers it knows.
 */
export const NOT_TYPED = ['<local-command-stdout>', '<task-notification>', '<system-reminder>', '<teammate-message']

/** The text a transcript message offers, by the rules of its role. null: skip it. */
export function backfillText(role: 'user' | 'assistant', text: string): string | null {
  if (text === '') return null
  if (role === 'assistant') return text
  if (NOT_TYPED.some(tag => text.includes(tag))) return null
  return text.includes('<command-args>') ? commandArgs(text) : text
}

/** A row of a replayed transcript: a prompt is the user's text, anything else Claude's. */
function replayed(ev: RowEvent): Reading | null {
  if (ev.door !== 'prompt' && ev.door !== 'response') return null
  const user = ev.door === 'prompt'
  const text = backfillText(user ? 'user' : 'assistant', ev.text)
  return text === null ? null : reading(text, 'full', user ? 'prompt' : 'response')
}

/** What to read of a row, or null when the row carries no text for items. */
export function readingOf(ev: RowEvent): Reading | null {
  if (!ev.hasMessage) return null
  if (ev.origin === 'replay') return replayed(ev)
  return Object.hasOwn(DOORS, ev.door) ? DOORS[ev.door]!(ev) : null
}
