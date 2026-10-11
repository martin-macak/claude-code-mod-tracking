import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { budgetError, render } from '../render/render.ts'

const [scenarioDir, gif] = process.argv.slice(2)
if (scenarioDir === undefined || gif === undefined) {
  console.error('usage: node bin/render.ts <scenario dir> <out.gif>')
  process.exit(2)
}
mkdirSync(dirname(gif), { recursive: true })
const bytes = render(scenarioDir, gif)
const error = budgetError(bytes)
if (error !== undefined) {
  console.error(error)
  process.exit(1)
}
console.log(`demo: wrote ${gif} (${Math.round(bytes / 1024)} KB)`)
