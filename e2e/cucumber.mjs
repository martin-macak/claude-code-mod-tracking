// Node 24 strips the TypeScript types of the imported files, so no loader is needed.
const common = {
  paths: ['features/**/*.feature'],
  import: ['support/world.ts', 'steps/**/*.ts'],
  format: ['progress'],
  strict: true,
}

export default common

export const demo = { ...common, tags: '@demo' }
