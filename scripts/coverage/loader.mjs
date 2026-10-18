// Resolve hooks for `make coverage`: the pure tests run under `node --test`, so the
// kit modules and the extensionless imports of the mod need help. Use it with
// `node --experimental-transform-types --import scripts/coverage/loader.mjs`.
//
// - 'claude-code/testing' -> kit-shim.ts (test and a Jest-like expect)
// - 'claude-code'         -> claude-code-stub.ts (exports nothing)
// - './x' or '../x' with no extension -> the first file that exists of x.ts, x.tsx, x/index.ts
//   (tsconfig uses moduleResolution "bundler", which allows this; Node does not)
//   Node cannot load .tsx. An import that lands on one fails with "Unknown file extension",
//   which names the file: a pure test must not reach JSX.
import { statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SHIM = new URL('./kit-shim.ts', import.meta.url).href
const STUB = new URL('./claude-code-stub.ts', import.meta.url).href

const RELATIVE = /^\.{1,2}(\/|$)/
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/
const CANDIDATES = ['.ts', '.tsx', '/index.ts']

const isFile = path => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'claude-code/testing') return { url: SHIM, shortCircuit: true }
    if (specifier === 'claude-code') return { url: STUB, shortCircuit: true }
    if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier) && context.parentURL?.startsWith('file:')) {
      const base = fileURLToPath(new URL(specifier, context.parentURL))
      for (const candidate of CANDIDATES) {
        if (isFile(base + candidate)) return { url: pathToFileURL(base + candidate).href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})
