// Node 24 strips the TypeScript types of the imported files, so no loader is needed.
const base = {
  import: ['support/world.ts', 'steps/**/*.ts'],
  format: ['progress'],
  strict: true,
}

const common = { ...base, paths: ['features/**/*.feature'] }

export default common

export const demo = { ...common, tags: '@demo' }

// A profile with no `paths`, to run what the command line names and nothing else:
// `npx cucumber-js -p one features/pane.feature:286`. A positional path with the default profile merges with its
// `paths`, so the scenario runs together with every scenario of the other feature files (README.md).
export const one = base
