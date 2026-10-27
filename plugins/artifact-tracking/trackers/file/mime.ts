// The type of a file that the map does not know (issue #57, R7). One `file -b --mime-type -- <path>` call for each such file,
// through the `file` ToolSpec (probe, timeout and circuit breaker), off the `tool.call` hook: a call of the tool starts the job
// with `clock.after(0)` and returns at once, so the hook never waits for a process. The answer is kept on the record (`mime`),
// so the call is made once for a record. A record that goes (`/track clear`, a cap, a session switch that drops the answer)
// takes its answer with it, and the next record of that path is asked again. A tick looks again, for a record that a restore
// or a replay brought back with no answer and for a call that came before the probe of `file` settled.
// One job runs at a time for a load. A path whose call failed is not tried again until the generation moves (`/track clear` or
// a session switch). No `file` on the host, `mime: false` or an open breaker: the type stays `other`.

import type { Json, StoredItem } from '../../core/interfaces/items'
import type { ToolSpec, TrackerContext } from '../../core/interfaces/tracker'
import { LoadState } from '../../core/lib/load-state'
import { message } from '../../core/lib/text'
import type { FileConfig } from './config'
import { mimeOf, typeOfName } from './file-type'
import { fileKind } from './kind'
import type { FileRecord } from './types'

/** The CLI of the type lookup. `file --version` answers on macOS and on Linux. */
export const FILE_TOOL: ToolSpec = { id: 'file', probe: ['file', '--version'] }

type Ctx = TrackerContext<FileConfig, Json>

/**
 * What one load keeps: whether a job runs, whether a call came while it ran, the keys whose call failed, and the generation
 * they belong to. Only a failure is kept here. An answer sits on the record, so a record that goes takes it along and the
 * next record of that path is asked again. The failed keys go when the generation moves (`/track clear`, a session switch):
 * each path whose call failed gets one more chance then, and the breaker bounds the calls.
 */
type Job = { running: boolean; again: boolean; tried: Set<string>; generation: number }
const jobs = new LoadState<Job>()

/** The records that wait for an answer: a name the map does not know, still there, with no answer and no failed try. */
function pending(list: readonly StoredItem[], tried: ReadonlySet<string>): FileRecord[] {
  return list.flatMap(item => {
    const rec = fileKind.decode(item)
    return rec && rec.mime === undefined && !rec.deleted && !tried.has(rec.key) && typeOfName(rec.label) === undefined
      ? [rec]
      : []
  })
}

/**
 * Starts the job, or tells the one that runs to look again. Returns at once and never rejects. The job runs at the next turn of
 * the clock, after the hook that started it has returned. `mime: false` starts none.
 */
export function typeUnknownFiles(ctx: Ctx): void {
  if (!ctx.config.slice().mime) return
  const job = jobs.of(ctx, () => ({ running: false, again: false, tried: new Set(), generation: ctx.generation }))
  if (job.running) {
    job.again = true
    return
  }
  job.running = true
  // The engine runs the callback and ignores what it returns; the mini clock of the tests awaits it.
  ctx.clock.after(0, (() => run(ctx, job)) as () => void)
}

async function run(ctx: Ctx, job: Job): Promise<void> {
  try {
    do {
      job.again = false
      await typeOnce(ctx, job)
    } while (job.again)
  } catch (e) {
    // The job is best effort: a record with no answer is `other`. The next call or tick looks again. The log says why.
    ctx.log(`file: type lookup failed: ${message(e)}`)
  } finally {
    job.running = false
  }
}

/** One pass: asks `file` for each record that waits, then writes every answer in one update. */
async function typeOnce(ctx: Ctx, job: Job): Promise<void> {
  const handle = ctx.tools.handle(FILE_TOOL.id)
  if (!handle) return
  // The generation is read before the list: a write after a session switch finds it moved, and `update` drops it.
  const since = ctx.generation
  if (job.generation !== since) {
    // `/track clear` or a session switch: the generation moved, so a path whose call failed gets one more chance.
    job.tried.clear()
    job.generation = since
  }
  const waiting = pending(await ctx.items.list(), job.tried)
  if (waiting.length === 0) return
  // The probe runs once and its answer is cached: a job that starts before it settled waits for it.
  if (!(await handle.probe())) return
  const answers = new Map<string, string>()
  for (const rec of waiting) {
    if (!handle.canCall(ctx.clock.wall())) break
    const out = await handle.exec(['file', '-b', '--mime-type', '--', rec.url])
    // null: the breaker held the call back, or it could not start (the handle recorded that). Look again later.
    if (out === null) continue
    if (out.exitCode !== 0) {
      job.tried.add(rec.key)
      handle.record('tool-failure', `exit ${out.exitCode}`)
      continue
    }
    handle.record('ok')
    answers.set(rec.key, mimeOf(out.stdout))
  }
  if (answers.size === 0) return
  await ctx.items.update(
    list => {
      let changed = false
      const next = list.map(item => {
        const answer = answers.get(item.key)
        if (answer === undefined || item.category !== 'file' || item.mime !== undefined) return item
        changed = true
        return { ...item, mime: answer }
      })
      return changed ? next : list
    },
    { since },
  )
}
