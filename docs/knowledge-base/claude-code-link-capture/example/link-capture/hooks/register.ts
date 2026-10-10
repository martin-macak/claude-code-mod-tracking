import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Captured } from '../types'
import { mergeLinks, scanMarkdown, scanOsc8, textOfContent } from './links'
import type { Found, Source } from './links'

// Working set: $.state (survives hot reload, versioned, one writer at a time through `update`).
// Mirror: $.store, one key per session, so /clear and a new process can restore it.
const links = atom({ plugin: 'link-capture', key: 'links' } as const, [] as Captured[])
const dropped = atom({ plugin: 'link-capture', key: 'dropped' } as const, 0)

const CAP = 500 // links kept in $.state
const KEEP_SESSIONS = 20 // sessions kept in $.store (the whole store may hold 4 MiB)
const FLUSH_MS = 1500

let flushing = false // module variables: lost on reload, which only costs one early flush or one skipped check
let knownId: string | undefined // the session id last seen; a change means /clear, /resume or /branch

// ------------------------------------------------------------------ record

/** Merge `found` into the session list. Never throws into the caller. */
async function record($: EngineInterface, found: Found[], src: Source): Promise<void> {
  if (found.length === 0) return
  let lost = 0
  await update($, links, (list) => {
    const r = mergeLinks(list ?? [], found, src, CAP)
    lost = r.dropped
    return r.list
  })
  if (lost > 0) await update($, dropped, (n) => (n ?? 0) + lost)
  schedule($)
}

/** Copy the list to $.store later. Many rows in one burst make one write. */
function schedule($: EngineInterface): void {
  if (flushing) return
  flushing = true
  $.clock.after(FLUSH_MS, async () => {
    flushing = false
    try {
      await flush($)
    } catch {
      // A failed copy is retried by the next capture.
    }
  })
}

async function flush($: EngineInterface): Promise<void> {
  const list = await read($, links)
  if (list.length === 0) return // after /clear: never replace a stored copy with an empty one
  const id = await $.session.id()
  await $.store.set('s:' + id, { links: list })
  const index = ((await $.store.get('index')) as string[] | undefined) ?? []
  const next = [id, ...index.filter((x) => x !== id)]
  for (const old of next.slice(KEEP_SESSIONS)) await $.store.delete('s:' + old)
  await $.store.set('index', next.slice(0, KEEP_SESSIONS))
}

// ------------------------------------------------------------------ restore

/**
 * Fill the list again from what the session knows. `--resume` loads rows without appending them
 * (reference.md:137), and /clear, /resume and /branch reset $.state (gotcha 11). The transcript is
 * the source when it holds rows. The stored copy covers /clear, which empties the transcript.
 */
async function restore($: EngineInterface, source: string): Promise<void> {
  if ((await read($, links)).length > 0) return // a hot reload keeps $.state; nothing to restore
  const src: Source = { door: 'transcript', uuid: '' }
  const messages = await $.session.messages()
  if (Array.isArray(messages)) {
    const all: Found[] = []
    for (const m of messages) {
      if (m.role === 'assistant' && m.text !== '') all.push(...scanMarkdown(m.text))
      for (const use of m.toolUses) if (use.text) all.push(...scanOsc8(use.text))
    }
    await record($, all, src) // one state write for the whole transcript
  }
  if ((await read($, links)).length > 0) return
  const id = await $.session.id()
  const index = ((await $.store.get('index')) as string[] | undefined) ?? []
  // /resume names a session that has a stored copy; /clear gives an id the store has not seen, so take the last other one
  const from = index.includes(id) ? id : source === 'startup' ? undefined : index.find((x) => x !== id)
  const stored = from === undefined ? undefined : ((await $.store.get('s:' + from)) as { links?: Captured[] } | undefined)
  if (stored?.links && stored.links.length > 0) await update($, links, () => stored.links!.slice(-CAP))
}

/**
 * /clear, /resume and /branch give the session a new id and reset $.state, and `session.start`
 * does not fire again. The documented `classic.SessionStart` hook did not run for a user-tier mod
 * in the live check (the built-in sec-default bypassed it), so compare ids on every use instead.
 */
async function ensure($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  if (knownId === id) return
  const hadId = knownId !== undefined
  knownId = id
  if (hadId) await restore($, 'clear')
}

// ------------------------------------------------------------------ /links

const SHOWN = 30

function render(list: readonly Captured[], args: string, lost: number): string {
  const all = /\ball\b/.test(args)
  const limit = Number(/\b(\d+)\b/.exec(args)?.[1] ?? SHOWN)
  const rows = list.filter((c) => all || (c.kind === 'link' && c.web))
  if (rows.length === 0) return all ? 'No links captured yet.' : 'No web links captured yet. `/links all` lists the rest.'
  const shown = rows.slice(-limit)
  const lines = shown.map((c, k) => {
    const tag = [c.via, c.kind === 'link' ? '' : 'plain text', c.agentId ? 'subagent' : '', c.n > 1 ? `x${c.n}` : ''].filter(Boolean).join(', ')
    return `${rows.length - shown.length + k + 1}. ${c.label && c.label !== c.url ? c.label + ' - ' : ''}${c.url} (${tag})`
  })
  const head = `${rows.length} link${rows.length === 1 ? '' : 's'}${shown.length < rows.length ? `, last ${shown.length}` : ''}${lost > 0 ? `, ${lost} older dropped` : ''}:`
  return head + '\n' + lines.join('\n')
}

// ------------------------------------------------------------------ hooks

export const register: Register = (on) => {
  // Assistant text. One row per content block, complete, in order.
  // Observe only: `next` stores the row first, then we scan what was stored.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      await ensure($)
      if (stored.message) {
        const found = scanMarkdown(textOfContent(stored.message.content))
        await record($, found, { door: e.door, uuid: e.uuid, agentId: e.agentId })
      }
    } catch {
      // A scanner or state fault must not touch the row.
    }
    return stored
  }).catch(($, e, next) => next(e))

  // Tool output. Raw OSC 8 bytes survive here.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      await ensure($)
      if (stored.message) {
        const found = scanOsc8(textOfContent(stored.message.content))
        await record($, found, { door: e.door, uuid: e.uuid, agentId: e.agentId })
      }
    } catch {
      // See above.
    }
    return stored
  }).catch(($, e, next) => next(e))

  // Once per process: register the command and load what a resume brought in.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'links', description: 'List the links Claude showed this session', argumentHint: '[all] [count]' })
    try {
      knownId = await $.session.id()
      await restore($, 'startup')
    } catch {
      // The list stays empty. New rows still land.
    }
    return next(e)
  })

  on('command.run', { command: 'links' }, async ($, e, next) => {
    await ensure($)
    return { text: render(await read($, links), e.args, await read($, dropped)) }
  }).catch(() => ({ text: 'link-capture: could not read the list.' }))
}
