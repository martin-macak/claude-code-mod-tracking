// Runs workflow.js with fake Workflow globals, so tests check its control flow.
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../workflow.js', import.meta.url), 'utf8').replace(
  /^export const meta\s*=/m,
  'const meta =',
)
const AsyncFunction = (async () => {}).constructor

export async function runWorkflow({ args, agent }) {
  const logs = []
  const calls = []
  const spy = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return agent(prompt, opts)
  }
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, index) => {
        let value = item
        for (const stage of stages) {
          try {
            value = await stage(value, item, index)
          } catch {
            return null
          }
        }
        return value
      }),
    )
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const run = new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', SOURCE)
  const result = await run(spy, pipeline, parallel, () => {}, (m) => logs.push(m), args)
  return { result, logs, calls }
}
