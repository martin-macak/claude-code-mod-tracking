// Node 24 strips the TypeScript types of the imported files, so no loader is needed.
const base = {
  import: ['support/world.ts', 'steps/**/*.ts'],
  format: ['progress'],
  strict: true,
}

const everything = { ...base, paths: ['features/**/*.feature'] }

// The default profile skips the @artifacts scenario. It publishes a private page to claude.ai with the login of the
// person, so a command that only names a feature file (`npx cucumber-js features/pane.feature`) must never run it.
// The tag expressions of a profile and of the command line are joined with `and`, so `--tags @artifacts` on top of
// this profile selects nothing: opt in with `-p artifacts` (or `-p all`).
export default { ...everything, tags: 'not @artifacts' }

export const demo = { ...everything, tags: '@demo' }

// Opt in: the @artifacts scenario alone. A named profile replaces the default one.
export const artifacts = { ...everything, tags: '@artifacts' }

// Opt in: every scenario, @artifacts included. `make e2e` runs this profile. A tag expression cannot join the default
// profile with `artifacts` (`(not @artifacts) and @artifacts` selects nothing), so this one has no tag expression.
export const all = everything

// A profile with no `paths`, to run what the command line names and nothing else:
// `npx cucumber-js -p one features/pane.feature:286`. A positional path with the default profile merges with its
// `paths`, so the scenario runs together with every scenario of the other feature files (README.md).
// With no path at all, cucumber falls back to every feature file, so this profile skips @artifacts too.
export const one = { ...base, tags: 'not @artifacts' }
