// Spike G11. `n` is a $.state atom. session.end records what it sees to $.store (the test reads that Map).
import type { Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

const n = atom({ plugin: 'kit-end', key: 'n' } as const, 0)

export const register: Register = on => {
  on('command.run', { command: 'bump' }, async $ => {
    const v = await update($, n, c => (c ?? 0) + 1)
    return { text: 'n=' + String(v) }
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'peek' }, async $ => {
    const id = await $.session.id()
    const v = await read($, n)
    return { text: JSON.stringify({ n: v, id }) }
  }).catch((_$, e, next) => next(e))

  on('session.start', async (_$, e, next) => next(e)).catch((_$, e, next) => next(e))

  // The new session after a /clear is announced by the classic SessionStart event with source `clear`.
  on('classic.SessionStart', { source: ['clear', 'resume'] }, async ($, e, next) => {
    await $.store.set('start-' + e.source, { source: e.source, idInside: await $.session.id(), nInside: await read($, n) })
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const idInside = await $.session.id()
    const nInside = await read($, n)
    let writeInside = 'ok'
    try {
      await update($, n, () => 99) // may a session.end hook write state?
    } catch (err) {
      writeInside = 'refused: ' + String((err as Error).message)
    }
    const nAfterWrite = await read($, n)
    const key = 'end-' + e.reason
    await $.store.set(key, {
      reason: e.reason,
      sessionId: e.sessionId,
      resumeId: e.resume.id,
      idInside,
      nInside,
      writeInside,
      nAfterWrite,
      budgetMs: next.budget.ms,
      budgetRemaining: Number.isFinite(next.budget.remainingMs) ? next.budget.remainingMs : 'Infinity',
    })
    return next(e)
  }).catch((_$, e, next) => next(e))
}
