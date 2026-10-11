import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slug } from '../support/slug.ts'

test('slug makes a folder name from a scenario name', () => {
  assert.equal(slug('A mentioned PR shows in the band!'), 'a-mentioned-pr-shows-in-the-band')
  assert.equal(slug('***'), 'scenario')
})
