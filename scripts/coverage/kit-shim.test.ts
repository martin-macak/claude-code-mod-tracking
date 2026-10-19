// Pins the semantics of kit-shim.ts against the kit's `expect`. A test that passes
// under one runner and fails under the other would break the coverage gate.
// Run: node --experimental-transform-types --test scripts/coverage/kit-shim.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test as nodeTest } from 'node:test'
import { fileURLToPath } from 'node:url'
import { expect } from './kit-shim.ts'

/** Asserts that `fn` throws and returns the error message. */
function thrown(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  assert.fail('expected the call to throw')
}

nodeTest('toEqual ignores undefined properties, toStrictEqual does not', () => {
  expect({ a: 1, b: undefined }).toEqual({ a: 1 })
  expect({ a: 1 }).toEqual({ a: 1, b: undefined })
  assert.throws(() => expect({ a: 1, b: undefined }).toStrictEqual({ a: 1 }))
  assert.throws(() => expect({ a: 1 }).toStrictEqual({ a: 1, b: undefined }))
  expect({ a: 1, b: undefined }).toStrictEqual({ a: 1, b: undefined })
})

nodeTest('toEqual compares arrays by length, so an undefined item still counts', () => {
  expect([1, 2]).toEqual([1, 2])
  assert.throws(() => expect([1, 2]).toEqual([1, 2, undefined]))
  assert.throws(() => expect([1, 2, undefined]).toEqual([1, 2]))
  assert.throws(() => expect([]).toEqual({}))
})

nodeTest('toEqual is deep and takes the type of a value into account', () => {
  expect({ a: [{ b: 1 }], c: new Map([[1, 2]]), d: new Set([1]) }).toEqual({
    a: [{ b: 1 }],
    c: new Map([[1, 2]]),
    d: new Set([1]),
  })
  expect(new Date(5)).toEqual(new Date(5))
  assert.throws(() => expect(new Date(5)).toEqual(new Date(6)))
  assert.throws(() => expect({ a: { b: 1 } }).toEqual({ a: { b: 2 } }))
  assert.throws(() => expect(1).toEqual('1'))
  expect(Number.NaN).toEqual(Number.NaN)
  expect(null).toEqual(null)
  assert.throws(() => expect(null).toEqual(undefined))
})

nodeTest('toStrictEqual checks the prototype', () => {
  class P {
    a = 1
  }
  expect(new P()).toEqual({ a: 1 })
  assert.throws(() => expect(new P()).toStrictEqual({ a: 1 }))
  expect(new P()).toStrictEqual(new P())
})

nodeTest('toMatchObject accepts a subset of the properties', () => {
  expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } })
  assert.throws(() => expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 9 } }))
  assert.throws(() => expect({ a: 1 }).toMatchObject({ z: 1 }))
  // The property must exist, also when the expected value is undefined (as in the kit).
  assert.throws(() => expect({ a: 1 }).toMatchObject({ z: undefined }))
  expect({ a: 1, z: undefined }).toMatchObject({ z: undefined })
  assert.throws(() => expect({ d: new Date(5) }).toMatchObject({ d: new Date(6) }))
  expect({ d: new Date(5) }).toMatchObject({ d: new Date(5) })
  expect({ n: 1 }).not.toMatchObject({ n: 2 })
  expect({ list: [{ a: 1, b: 2 }] }).toMatchObject({ list: [{ a: 1 }] })
  assert.throws(() => expect({ list: [{ a: 1 }, { a: 2 }] }).toMatchObject({ list: [{ a: 1 }] }))
  assert.throws(() => expect(null).toMatchObject({ a: 1 }))
})

nodeTest('toContain, toContainEqual, toHaveLength', () => {
  expect([1, 2]).toContain(2)
  expect('abc').toContain('b')
  expect([{ a: 1 }]).not.toContain({ a: 1 })
  expect([{ a: 1 }]).toContainEqual({ a: 1 })
  assert.throws(() => expect([1, 2]).toContain(3))
  assert.throws(() => expect('abc').toContain('z'))
  expect([1, 2, 3]).toHaveLength(3)
  expect('ab').toHaveLength(2)
  assert.throws(() => expect([1]).toHaveLength(2))
})

nodeTest('the simple matchers and their negations', () => {
  expect(1).toBe(1)
  expect(1).not.toBe(2)
  assert.throws(() => expect({}).toBe({}))
  expect(null).toBeNull()
  expect(undefined).toBeUndefined()
  expect(0).toBeDefined()
  assert.throws(() => expect(undefined).toBeDefined())
  expect('x').toBeTruthy()
  expect(0).toBeFalsy()
  expect(1).toBeLessThan(2)
  expect(2).toBeLessThanOrEqual(2)
  expect(3).toBeGreaterThan(2)
  expect(2).toBeGreaterThanOrEqual(2)
  assert.throws(() => expect(2).toBeLessThan(2))
  expect(new Error('e')).toBeInstanceOf(Error)
  assert.throws(() => expect({}).toBeInstanceOf(Error))
  expect('hello world').toMatch(/o w/)
  expect('hello world').toMatch('lo w')
  assert.throws(() => expect('abc').toMatch(/z/))
  assert.throws(() => expect(1).not.toBe(1))
})

nodeTest('asymmetric matchers work inside toEqual', () => {
  expect({ n: 3, s: 'x' }).toEqual({ n: expect.any(Number), s: expect.stringMatching(/x/) })
  expect({ s: 'abc' }).toEqual({ s: expect.stringContaining('b') })
  expect({ a: 1, b: 2 }).toEqual(expect.objectContaining({ a: 1 }))
  expect([1, 2, 3]).toEqual(expect.arrayContaining([3, 1]))
  expect({ a: 0 }).toEqual({ a: expect.anything() })
  assert.throws(() => expect({ a: null }).toEqual({ a: expect.anything() }))
  assert.throws(() => expect({ n: 'x' }).toEqual({ n: expect.any(Number) }))
  assert.throws(() => expect([1]).toEqual(expect.arrayContaining([2])))
  expect({ p: 'x' }).toMatchObject({ p: expect.any(String) })
  // objectContaining goes as deep as toMatchObject does (as in the kit).
  expect({ a: { b: 1, c: 2 } }).toEqual(expect.objectContaining({ a: { b: 1 } }))
  assert.throws(() => expect({ a: 1 }).toEqual(expect.objectContaining({ z: undefined })))
  assert.throws(() => expect(5).toEqual(expect.objectContaining({ a: 1 })))
  expect({ a: 'x', f: () => 1, l: [], b: true, o: {}, g: 1n, s: Symbol('s') }).toEqual({
    a: expect.any(String),
    f: expect.any(Function),
    l: expect.any(Array),
    b: expect.any(Boolean),
    o: expect.any(Object),
    g: expect.any(BigInt),
    s: expect.any(Symbol),
  })
  assert.throws(() => expect({ a: null }).toEqual({ a: expect.any(Object) }))
  expect({ s: 'ab' }).toEqual({ s: expect.stringMatching('a.') })
  assert.throws(() => expect({ s: 5 }).toEqual({ s: expect.stringContaining('5') }))
  assert.match(
    thrown(() => expect({ n: 'x' }).toEqual({ n: expect.any(Number) })),
    /Any<Number>/,
  )
})

nodeTest('resolves and rejects', async () => {
  await expect(Promise.resolve(2)).resolves.toBe(2)
  await expect(Promise.reject(new Error('e'))).rejects.toBeInstanceOf(Error)
  await assert.rejects(async () => expect(Promise.resolve(2)).resolves.toBe(3))
  await assert.rejects(async () => expect(Promise.resolve(2)).rejects.toBeInstanceOf(Error))
  await assert.rejects(async () => expect(Promise.reject(new Error('e'))).resolves.toBe(2))
  await expect(Promise.resolve(2)).resolves.not.toBe(3)
})

nodeTest('toThrow', () => {
  expect(() => {
    throw new Error('boom')
  }).toThrow('boom')
  expect(() => {
    throw new Error('boom')
  }).toThrow(/bo+m/)
  expect(() => {
    throw new Error('boom')
  }).toThrow()
  expect(() => 1).not.toThrow()
  assert.throws(() => expect(() => 1).toThrow())
  assert.throws(() =>
    expect(() => {
      throw new Error('boom')
    }).toThrow('other'),
  )
  assert.throws(() =>
    expect(() => {
      throw new Error('boom')
    }).not.toThrow(),
  )
})

nodeTest('a message argument prefixes the failure', () => {
  assert.match(
    thrown(() => expect(1, 'ctx').toBe(2)),
    /^ctx: /,
  )
  assert.match(
    thrown(() => expect(1, 'ctx').not.toBe(1)),
    /^ctx: /,
  )
  assert.doesNotMatch(
    thrown(() => expect(1).toBe(2)),
    /^ctx: /,
  )
})

nodeTest('toThrow takes a substring, a pattern, a class or a whole message', () => {
  const boom = () => {
    throw new TypeError('boom!')
  }
  expect(boom).toThrow(TypeError)
  expect(boom).toThrow(Error)
  assert.throws(() => expect(boom).toThrow(RangeError))
  expect(boom).toThrow({ message: 'boom!' })
  assert.throws(() => expect(boom).toThrow({ message: 'boom' }))
  expect(boom).not.toThrow('other')
  assert.throws(() => expect(boom).not.toThrow('boom'))
  expect(() => {
    throw 'text'
  }).toThrow('text')
  assert.throws(() => expect(5).toThrow())
  assert.match(
    thrown(() => expect(5).toThrow()),
    /expected a function to call/,
  )
})

nodeTest('rejects.toThrow checks the rejection, not a call', async () => {
  await expect(Promise.reject(new Error('boom'))).rejects.toThrow('boom')
  await expect(Promise.reject(new TypeError('boom'))).rejects.toThrow(TypeError)
  await assert.rejects(async () => expect(Promise.reject(new Error('boom'))).rejects.toThrow('zzz'))
  await assert.rejects(async () => expect(5).resolves.toBe(5), /expected a promise/)
})

nodeTest('toHaveProperty, toBeNaN, toStartWith, toEndWith', () => {
  expect({ a: { b: 1 } }).toHaveProperty('a.b')
  expect({ a: { b: 1 } }).toHaveProperty('a.b', 1)
  expect({ a: { b: 1 } }).toHaveProperty(['a', 'b'], 1)
  expect({ z: undefined }).toHaveProperty('z')
  expect({ z: undefined }).toHaveProperty('z', undefined)
  assert.throws(() => expect({ z: 1 }).toHaveProperty('z', undefined))
  assert.throws(() => expect({ a: 1 }).toHaveProperty('z'))
  assert.throws(() => expect({ a: 1 }).toHaveProperty('a', 2))
  assert.throws(() => expect(null).toHaveProperty('a'))
  expect(Number.NaN).toBeNaN()
  assert.throws(() => expect(1).toBeNaN())
  expect('hello').toStartWith('he')
  expect('hello').toEndWith('lo')
  assert.throws(() => expect(5).toStartWith('5'))
  assert.throws(() => expect('hello').toEndWith('he'))
})

nodeTest('the shim agrees with the kit where the kit differs from Jest', () => {
  // Checked against `claude plugin test` 2.1.302.
  expect(new Error('a')).toEqual(new Error('b'))
  expect({ [Symbol.for('s')]: 1 }).toEqual({ [Symbol.for('s')]: 2 })
  // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
  expect([, 1]).toStrictEqual([undefined, 1])
  expect('1').toBeLessThan(2)
  assert.throws(() => expect(/a/).toEqual(/b/))
  assert.throws(() => expect(0).toEqual(-0))
  assert.throws(() => expect(0).toBe(-0))
  expect(Number.NaN).toBe(Number.NaN)
  assert.throws(() => expect(['abc']).toContain('b'))
  expect(new Set([1, 2])).toContain(2)
  expect([Number.NaN]).toContain(Number.NaN)
  assert.throws(() => expect({}).toHaveLength(0))
  expect({ length: 2 }).toHaveLength(2)
})

nodeTest('toEqual covers maps, sets and cycles', () => {
  expect(new Map([[1, { a: 1, b: undefined }]])).toEqual(new Map([[1, { a: 1 }]]))
  assert.throws(() => expect(new Map([[1, 1]])).toEqual(new Map([[1, 2]])))
  assert.throws(() =>
    expect(new Map([[1, 1]])).toEqual(
      new Map([
        [1, 1],
        [2, 2],
      ]),
    ),
  )
  expect(new Set([{ a: 1 }])).toEqual(new Set([{ a: 1 }]))
  assert.throws(() => expect(new Set([1])).toEqual(new Set([2])))
  assert.throws(() => expect(new Set([1])).toEqual(new Set([1, 2])))
  const a: Record<string, unknown> = {}
  a.self = a
  const b: Record<string, unknown> = {}
  b.self = b
  expect(a).toEqual(b)
  assert.throws(() => expect({ f: () => 1 }).toEqual({ f: () => 1 }))
})

// ---- the loader and the call shape of `test` ----

const LOADER = fileURLToPath(new URL('./loader.mjs', import.meta.url))

/** Runs a pure test file under node --test with the loader, as `make coverage` does. */
function runPure(files: Record<string, string>, main: string): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kit-shim-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    // Inside `node --test` this variable makes a child runner report to its parent and print nothing.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env
    const r = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings', '--import', LOADER, '--test', join(dir, main)],
      { encoding: 'utf8', env },
    )
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

nodeTest('the loader maps the kit modules and resolves extensionless imports', () => {
  const r = runPure(
    {
      'a.test.ts': `
        import { expect, test } from 'claude-code/testing'
        import type { Register } from 'claude-code'
        import { one } from './lib/one'
        import { two } from './lib/two.ts'
        import { three } from './lib'
        import data from './data.json' with { type: 'json' }
        const reg: Register | undefined = undefined
        test('imports', () => {
          expect([one, two, three, data.n, reg]).toEqual([1, 2, 3, 4, undefined])
        })
        test('an options object comes before the body', { timeoutMs: 1000 }, async () => {
          await expect(Promise.resolve(1)).resolves.toBe(1)
        })
      `,
      'lib/one.ts': 'export const one = 1',
      'lib/two.ts': 'export const two = 2',
      'lib/index.ts': 'export const three = 3',
      'data.json': '{ "n": 4 }',
    },
    'a.test.ts',
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /pass 2/)
})

nodeTest('an import that resolves to a .tsx file fails, because node cannot load JSX', () => {
  const r = runPure(
    {
      'd.test.ts': `import { test } from 'claude-code/testing'\nimport { view } from './view'\ntest('x', () => { view })\n`,
      'view.tsx': 'export const view = 1',
    },
    'd.test.ts',
  )
  assert.notEqual(r.code, 0)
  assert.match(r.out, /Unknown file extension "\.tsx"/)
})

nodeTest('a pure test that uses $ fails and says to rename it', () => {
  const r = runPure(
    {
      'b.test.ts': `import { test } from 'claude-code/testing'\ntest('kit', async ($: any) => { await $.fs.read('x') })\n`,
    },
    'b.test.ts',
  )
  assert.notEqual(r.code, 0)
  assert.match(r.out, /\$\.fs/)
  assert.match(r.out, /rename it to \*\.kit\.test\.ts/)
})

nodeTest('a value import from claude-code fails to load', () => {
  const r = runPure(
    {
      'c.test.ts': `import { atom } from 'claude-code'\nimport { test } from 'claude-code/testing'\ntest('x', () => { atom })\n`,
    },
    'c.test.ts',
  )
  assert.notEqual(r.code, 0)
  assert.match(r.out, /does not provide an export named 'atom'/)
})

// ---- the global h ----

nodeTest('the fake h builds the plain-data shape the kit draws', () => {
  assert.deepEqual(h('Box', { width: 3 }, h('Text', null, 'a'), ['b', null, false, [7]]), {
    type: 'Box',
    props: { width: 3 },
    children: [{ type: 'Text', children: ['a'] }, 'b', '7'],
  })
  assert.deepEqual(
    h(p => ({ type: 'X', props: p }), { k: 1 }, 'c'),
    { type: 'X', props: { k: 1, children: ['c'] } },
  )
})

// The engine leaves out an empty props and an empty children, drops a null or undefined prop and `children` in the
// props of a string tag, and gives a function tag a children list always (tests/h-shape.kit.test.ts pins the same).
nodeTest('the fake h leaves out what the engine leaves out', () => {
  assert.deepEqual(h('Box', null), { type: 'Box' })
  assert.deepEqual(h('Box', {}, null, false, true), { type: 'Box' })
  assert.deepEqual(h('Box', { a: null, b: undefined, c: 0, d: false, e: '', children: ['z'] }), {
    type: 'Box',
    props: { c: 0, d: false, e: '' },
  })
  assert.deepEqual(
    h(p => ({ type: 'X', props: p }), null),
    { type: 'X', props: { children: [] } },
  )
})
