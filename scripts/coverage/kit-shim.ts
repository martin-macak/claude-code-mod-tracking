// Stand-in for 'claude-code/testing' when the pure tests run under `node --test`
// (make coverage). It offers `test` and a Jest-like `expect`, and nothing else.
// The kit has no coverage option, so Node measures it. A test that needs `$` is a
// kit test: name it *.kit.test.ts or .tsx and only `claude plugin test` runs it.
//
// The matchers follow the kit's `expect`, checked against `claude plugin test`
// 2.1.302 (see kit-shim.test.ts). Where the kit differs from Jest, the kit wins:
// `toEqual` does not compare Errors by message, ignores symbol keys and array holes.
//
// It also sets the global `h` when none exists. A `ux/` module is `.ts` and calls `h(tag, props, ...children)` by name
// (spec 7.1), so node can load and measure it. The engine's own `h` is a global of the kit, so the shim never runs
// there; tests/h-shape.kit.test.ts pins the shape built here to the shape the engine builds.
import { test as nodeTest } from 'node:test'
import { inspect } from 'node:util'

declare global {
  // The engine's signature (claude-code 2.1.302 d.ts, `const h`), with the return left open: a node test reads plain data.
  var h: (
    tag: string | ((props: never) => unknown),
    props: Record<string, unknown> | null | undefined,
    ...children: unknown[]
  ) => unknown
}

type Body = ($: unknown, on: unknown) => unknown

/** What a pure test gets for `$` and `on`. Any use fails and says why. */
const noKit: unknown = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      throw new Error(`the test uses $.${prop}: rename it to *.kit.test.ts so only the kit runs it`)
    },
  },
)

/** Same call shape as the kit: `test(name, body)` or `test(name, { timeoutMs }, body)`. */
export function test(name: string, ...rest: [body: Body] | [options: { timeoutMs?: number }, body: Body]): void {
  const body = rest.length === 2 ? rest[1] : rest[0]
  const timeout = rest.length === 2 ? rest[0].timeoutMs : undefined
  nodeTest(name, timeout === undefined ? {} : { timeout }, async () => {
    await body(noKit, noKit)
  })
}

// ---- asymmetric matchers ----

/** A value that matches by a rule inside `toEqual` and `toMatchObject`. */
class Asymmetric {
  readonly text: string
  readonly matches: (received: unknown) => boolean
  constructor(text: string, matches: (received: unknown) => boolean) {
    this.text = text
    this.matches = matches
  }
  [inspect.custom](): string {
    return this.text
  }
}

// ---- equality ----

type Rec = Record<string, unknown>

const tag = (v: unknown): string => Object.prototype.toString.call(v)

/** Own enumerable string keys. `toEqual` leaves out the ones that hold undefined. */
function keysOf(o: object, strict: boolean): string[] {
  return Object.keys(o).filter(k => strict || (o as Rec)[k] !== undefined)
}

/**
 * Deep equality. `strict` (toStrictEqual) also compares prototypes and counts properties that hold undefined.
 * `seen` holds the pairs on the path from the root, so a cycle ends.
 */
function equals(a: unknown, b: unknown, strict: boolean, seen: [unknown, unknown][] = []): boolean {
  if (b instanceof Asymmetric) return b.matches(a)
  if (a instanceof Asymmetric) return a.matches(b)
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (tag(a) !== tag(b)) return false
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime())
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (seen.some(([x, y]) => x === a && y === b)) return true
  const path: [unknown, unknown][] = [...seen, [a, b]]
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false
    const entries = [...b]
    return [...a].every(([ka, va]) =>
      entries.some(([kb, vb]) => equals(ka, kb, strict, path) && equals(va, vb, strict, path)),
    )
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false
    const items = [...b]
    return [...a].every(x => items.some(y => equals(x, y, strict, path)))
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!equals(a[i], b[i], strict, path)) return false
    return true
  }
  const ka = keysOf(a, strict)
  const kb = keysOf(b, strict)
  if (ka.length !== kb.length) return false
  return ka.every(k => k in b && equals((a as Rec)[k], (b as Rec)[k], strict, path))
}

/** toMatchObject: `a` holds at least the properties of `b`, each equal; objects and arrays go deeper. */
function matchObject(a: unknown, b: unknown): boolean {
  if (b instanceof Asymmetric) return b.matches(a)
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((x, i) => matchObject(a[i], x))
  const plain = typeof b === 'object' && b !== null && tag(b) === '[object Object]'
  if (!plain) return equals(a, b, false)
  if (typeof a !== 'object' || a === null) return false
  return Object.keys(b).every(k => k in a && matchObject((a as Rec)[k], (b as Rec)[k]))
}

// ---- matchers ----

function fail(msg: string | undefined, text: string): never {
  throw new Error((msg ? `${msg}: ` : '') + text)
}

type Options = { negate: boolean; msg: string | undefined; rejection: boolean }

const show = (v: unknown): string => inspect(v, { depth: 6, breakLength: 100 })

/** Looks up `a.b` (or the keys in order). `found` is false when a key on the way is missing. */
function lookup(root: unknown, path: string | readonly string[]): { found: boolean; value: unknown } {
  let cur = root
  for (const key of typeof path === 'string' ? path.split('.') : path) {
    if (cur === null || cur === undefined || !(key in Object(cur))) return { found: false, value: undefined }
    cur = (cur as Rec)[key]
  }
  return { found: true, value: cur }
}

/** Does a thrown value fit what `toThrow` was given: a substring, a pattern, a class or `{ message }`? */
function throwFits(err: unknown, expected: unknown): boolean {
  if (expected === undefined) return true
  const message = err instanceof Error ? err.message : String(err)
  if (typeof expected === 'string') return message.includes(expected)
  if (expected instanceof RegExp) return expected.test(message)
  if (typeof expected === 'function') return err instanceof expected
  if (typeof expected === 'object' && expected !== null && 'message' in expected) return message === expected.message
  return false
}

function makeMatchers(received: unknown, o: Options) {
  const check = (pass: boolean, what: string, ...expected: unknown[]): void => {
    if (pass === o.negate) {
      const tail = expected.length ? ` ${show(expected[0])}` : ''
      fail(o.msg, `expected ${show(received)} ${o.negate ? 'not ' : ''}${what}${tail}`)
    }
  }
  const isText = typeof received === 'string'
  return {
    toBe: (e: unknown) => check(Object.is(received, e), 'to be', e),
    toEqual: (e: unknown) => check(equals(received, e, false), 'to equal', e),
    toStrictEqual: (e: unknown) => check(equals(received, e, true), 'to strictly equal', e),
    toMatchObject: (e: object) =>
      check(typeof received === 'object' && received !== null && matchObject(received, e), 'to match object', e),
    toContain: (e: unknown) =>
      check(
        isText
          ? typeof e === 'string' && received.includes(e)
          : isIterable(received) && Array.from(received).includes(e),
        'to contain',
        e,
      ),
    toContainEqual: (e: unknown) =>
      check(isIterable(received) && Array.from(received).some(x => equals(x, e, false)), 'to contain equal', e),
    toHaveLength: (n: number) =>
      check((received as { length?: unknown } | null | undefined)?.length === n, 'to have length', n),
    toHaveProperty: (path: string | readonly string[], ...value: unknown[]) => {
      const hit = lookup(received, path)
      check(hit.found && (value.length === 0 || equals(hit.value, value[0], false)), 'to have property', path)
    },
    toBeNull: () => check(received === null, 'to be null'),
    toBeUndefined: () => check(received === undefined, 'to be undefined'),
    toBeDefined: () => check(received !== undefined, 'to be defined'),
    toBeTruthy: () => check(Boolean(received), 'to be truthy'),
    toBeFalsy: () => check(!received, 'to be falsy'),
    toBeNaN: () => check(Number.isNaN(received), 'to be NaN'),
    toBeLessThan: (n: number | bigint) => check((received as number) < n, 'to be less than', n),
    toBeLessThanOrEqual: (n: number | bigint) => check((received as number) <= n, 'to be less than or equal to', n),
    toBeGreaterThan: (n: number | bigint) => check((received as number) > n, 'to be greater than', n),
    toBeGreaterThanOrEqual: (n: number | bigint) =>
      check((received as number) >= n, 'to be greater than or equal to', n),
    toBeInstanceOf: (c: abstract new (...a: never[]) => unknown) =>
      check(received instanceof c, 'to be an instance of', c),
    toMatch: (p: RegExp | string) =>
      check(isText && (typeof p === 'string' ? received.includes(p) : p.test(received)), 'to match', p),
    toStartWith: (s: string) => check(isText && received.startsWith(s), 'to start with', s),
    toEndWith: (s: string) => check(isText && received.endsWith(s), 'to end with', s),
    // Under `rejects` the received value is the rejection. Otherwise it is the function to call.
    toThrow: (expected?: unknown) => {
      let threw = o.rejection
      let err: unknown = received
      if (!o.rejection) {
        if (typeof received !== 'function') fail(o.msg, `expected a function to call, got ${show(received)}`)
        try {
          received()
        } catch (e) {
          threw = true
          err = e
        }
      }
      check(threw && throwFits(err, expected), 'to throw', ...(expected === undefined ? [] : [expected]))
    },
  }
}

const isIterable = (v: unknown): v is Iterable<unknown> => typeof v === 'object' && v !== null && Symbol.iterator in v

type Matchers = ReturnType<typeof makeMatchers>
type AsyncMatchers = { [K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => Promise<void> }

/** Waits for the promise. `resolves` needs it to resolve, `rejects` to reject. Gives the value or the rejection. */
async function settle(received: unknown, want: 'resolve' | 'reject', msg: string | undefined): Promise<unknown> {
  if (typeof (received as PromiseLike<unknown> | null)?.then !== 'function') {
    fail(msg, `expected a promise, got ${show(received)}`)
  }
  let value: unknown
  let rejected = false
  try {
    value = await (received as PromiseLike<unknown>)
  } catch (e) {
    value = e
    rejected = true
  }
  if (want === 'resolve' && rejected) fail(msg, `expected the promise to resolve, but it rejected with ${show(value)}`)
  if (want === 'reject' && !rejected) fail(msg, `expected the promise to reject, but it resolved with ${show(value)}`)
  return value
}

function asyncMatchers(received: unknown, want: 'resolve' | 'reject', negate: boolean, msg: string | undefined) {
  const names = Object.keys(makeMatchers(undefined, { negate, msg, rejection: false })) as (keyof Matchers)[]
  const out: Partial<Record<keyof Matchers, (...args: unknown[]) => Promise<void>>> = {}
  for (const name of names) {
    out[name] = async (...args: unknown[]) => {
      const value = await settle(received, want, msg)
      const matchers = makeMatchers(value, { negate, msg, rejection: want === 'reject' })
      ;(matchers[name] as (...a: unknown[]) => void)(...args)
    }
  }
  return out as AsyncMatchers
}

function expectation(received: unknown, msg?: string) {
  const plain = { negate: false, msg, rejection: false }
  return Object.assign(makeMatchers(received, plain), {
    not: makeMatchers(received, { ...plain, negate: true }),
    resolves: Object.assign(asyncMatchers(received, 'resolve', false, msg), {
      not: asyncMatchers(received, 'resolve', true, msg),
    }),
    rejects: Object.assign(asyncMatchers(received, 'reject', false, msg), {
      not: asyncMatchers(received, 'reject', true, msg),
    }),
  })
}

/** expect.any(C): a primitive matches by its wrapper class, as in the kit. */
function isAny(received: unknown, c: unknown): boolean {
  if (c === Number) return typeof received === 'number' || received instanceof Number
  if (c === String) return typeof received === 'string' || received instanceof String
  if (c === Boolean) return typeof received === 'boolean' || received instanceof Boolean
  if (c === BigInt) return typeof received === 'bigint'
  if (c === Symbol) return typeof received === 'symbol'
  if (c === Function) return typeof received === 'function'
  if (c === Object) return typeof received === 'object' && received !== null
  return typeof c === 'function' && received instanceof c
}

export const expect = Object.assign(expectation, {
  any: (c: { readonly name: string }) => new Asymmetric(`Any<${c.name}>`, v => isAny(v, c)),
  anything: () => new Asymmetric('Anything', v => v !== null && v !== undefined),
  objectContaining: (shape: object) =>
    new Asymmetric(
      `ObjectContaining ${show(shape)}`,
      v => typeof v === 'object' && v !== null && matchObject(v, shape),
    ),
  arrayContaining: (items: readonly unknown[]) =>
    new Asymmetric(
      `ArrayContaining ${show(items)}`,
      v => Array.isArray(v) && items.every(x => v.some(y => equals(y, x, false))),
    ),
  stringContaining: (text: string) =>
    new Asymmetric(`StringContaining ${show(text)}`, v => typeof v === 'string' && v.includes(text)),
  stringMatching: (pattern: string | RegExp) =>
    new Asymmetric(`StringMatching ${show(pattern)}`, v => typeof v === 'string' && new RegExp(pattern).test(v)),
})

// ---- the global h ----

/** The flat list of children without null, undefined, false and true. A number becomes its string. */
function flatChildren(list: readonly unknown[], out: unknown[] = []): unknown[] {
  for (const child of list) {
    if (Array.isArray(child)) flatChildren(child, out)
    else if (child === null || child === undefined || typeof child === 'boolean') continue
    else out.push(typeof child === 'number' ? String(child) : child)
  }
  return out
}

/**
 * What the engine builds, checked on `claude plugin test` 2.1.302 (tests/h-shape.kit.test.ts). A string tag gives
 * `{ type, props, children }`, but the engine leaves out `props` when no prop is left and `children` when there is none,
 * and it drops a prop that holds null or undefined, and `children` in the props. A function tag is called with the props
 * as given and `children`, always a list. The engine also checks a tag (a Button needs `onPress`, a Text takes no `key`)
 * and moves `onPress` to a handle. The stand-in does none of that: it is for a table of plain elements (`EL`).
 */
function fakeH(
  tag: string | ((props: never) => unknown),
  props: Record<string, unknown> | null | undefined,
  ...children: unknown[]
): unknown {
  const flat = flatChildren(children)
  if (typeof tag === 'function') return tag({ ...props, children: flat } as never)
  const kept = Object.entries(props ?? {}).filter(([k, v]) => k !== 'children' && v !== null && v !== undefined)
  return {
    type: tag,
    ...(kept.length > 0 ? { props: Object.fromEntries(kept) } : {}),
    ...(flat.length > 0 ? { children: flat } : {}),
  }
}

if (globalThis.h === undefined) globalThis.h = fakeH
