// The file format of the config file: parse, merge of missing keys, render and the normalised document. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 3 (decisions C8, C11, C17).
import { expect, test } from 'claude-code/testing'
import {
  CONFIG_VERSION,
  type DocSpec,
  isObject,
  mergeMissing,
  normaliseDoc,
  parseConfig,
  renderConfig,
  signatureOf,
} from '../core/infra/config-file'
import type { JsonObject } from '../core/interfaces/items'
import type { FsStat } from '../core/interfaces/ports'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { GITHUB_DEFAULTS, githubConfig } from '../trackers/github/config'
import { WEB_DEFAULTS, webConfig } from '../trackers/web/config'

const SPECS: readonly DocSpec[] = [
  { id: 'github', config: githubConfig },
  { id: 'web', config: webConfig },
]

const asObject = (v: unknown): JsonObject => v as JsonObject

test('CONFIG_VERSION is 1', () => {
  expect(CONFIG_VERSION).toBe(1)
})

test('signatureOf joins mtimeMs and size', () => {
  const st: FsStat = { kind: 'file', size: 22, mtimeMs: 1792230999936.3071, isLink: false }
  expect(signatureOf(st)).toBe('1792230999936.3071:22')
})

test('isObject: an object yes, null and an array and a string no', () => {
  expect(isObject({})).toBe(true)
  expect(isObject({ a: 1 })).toBe(true)
  expect(isObject(null)).toBe(false)
  expect(isObject([])).toBe(false)
  expect(isObject('x')).toBe(false)
  expect(isObject(3)).toBe(false)
})

test('parseConfig reads JSON', () => {
  expect(parseConfig('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
})

test('parseConfig strips a BOM', () => {
  expect(parseConfig('﻿{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
})

test('parseConfig: a comment or a trailing comma is a parse error', () => {
  for (const text of ['{ // x\n"a": 1 }', '{ "a": 1, }']) {
    const r = parseConfig(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(0)
      expect(r.error.endsWith('.')).toBe(false)
    }
  }
})

test('parseConfig: an empty text is a parse error', () => {
  expect(parseConfig('').ok).toBe(false)
})

test('mergeMissing adds missing keys deep and keeps user values', () => {
  const raw = asObject({ global: { tools: { breaker: { threshold: 5 } } }, trackers: { web: { enabled: false } } })
  const wanted = asObject({
    global: GLOBAL_DEFAULTS,
    trackers: { github: { enabled: true, chunkSize: 50 }, web: { enabled: true } },
  })
  const result = mergeMissing(raw, wanted)
  const global = asObject(result.global)
  expect(asObject(asObject(global.tools).breaker)).toEqual({ threshold: 5, openMs: 300000 })
  expect(asObject(global.refresh)).toEqual(GLOBAL_DEFAULTS.refresh)
  const trackers = asObject(result.trackers)
  expect(trackers.web).toEqual({ enabled: false })
  expect(trackers.github).toEqual({ enabled: true, chunkSize: 50 })
  expect(Object.keys(trackers)).toEqual(['web', 'github'])
})

test('mergeMissing keeps raw keys first, in raw order, then the added keys in wanted order', () => {
  const result = mergeMissing(asObject({ z: 1, a: 2 }), asObject({ a: 9, m: 3, b: 4 }))
  expect(Object.keys(result)).toEqual(['z', 'a', 'm', 'b'])
  expect(result).toEqual({ z: 1, a: 2, m: 3, b: 4 })
})

test('mergeMissing keeps a raw value where wanted has an object', () => {
  const result = mergeMissing(
    asObject({ trackers: { web: false } }),
    asObject({ trackers: { web: { enabled: true } } }),
  )
  expect(asObject(result.trackers).web).toBe(false)
})

test('mergeMissing keeps a raw object where wanted has a value', () => {
  expect(mergeMissing(asObject({ a: { b: 1 } }), asObject({ a: 5 }))).toEqual({ a: { b: 1 } })
})

test('mergeMissing keeps arrays as they are', () => {
  const result = mergeMissing(
    asObject({ shortRefKeywords: ['ticket'] }),
    asObject({ shortRefKeywords: ['bug', 'issue'] }),
  )
  expect(result.shortRefKeywords).toEqual(['ticket'])
})

test('mergeMissing does not change its inputs', () => {
  const raw = asObject({ a: { x: 1 } })
  const wanted = asObject({ a: { y: 2 }, b: 3 })
  mergeMissing(raw, wanted)
  expect(raw).toEqual({ a: { x: 1 } })
  expect(wanted).toEqual({ a: { y: 2 }, b: 3 })
})

test('mergeMissing treats a __proto__ key as data', () => {
  const raw = JSON.parse('{"__proto__":{"polluted":true}}') as JsonObject
  const result = mergeMissing(raw, asObject({ a: 1 }))
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect(result.a).toBe(1)
})

test('renderConfig puts version, global and trackers first, two spaces, one newline', () => {
  expect(renderConfig({ x: 1, trackers: {}, version: 1 })).toBe('{\n  "version": 1,\n  "trackers": {},\n  "x": 1\n}\n')
  expect(renderConfig({ x: 1, trackers: {}, global: {}, version: 1 })).toBe(
    '{\n  "version": 1,\n  "global": {},\n  "trackers": {},\n  "x": 1\n}\n',
  )
  expect(renderConfig({})).toBe('{}\n')
})

test('normaliseDoc: an empty object gives the defaults, version 1, no problem', () => {
  const doc = normaliseDoc({}, SPECS)
  expect(doc.version).toBe(1)
  expect(doc.readOnly).toBe(false)
  expect(doc.global).toEqual(GLOBAL_DEFAULTS)
  expect(doc.slices.get('github')).toEqual(GITHUB_DEFAULTS)
  expect(doc.slices.get('web')).toEqual(WEB_DEFAULTS)
  expect(doc.problems).toEqual([])
})

test('normaliseDoc: a complete file gives its values and no problem', () => {
  const doc = normaliseDoc(
    asObject({
      version: 1,
      global: { refresh: { tickMs: 60000 } },
      trackers: { github: { chunkSize: 10 }, web: { enabled: false } },
    }),
    SPECS,
  )
  expect(doc.global.refresh.tickMs).toBe(60000)
  expect(doc.global.refresh.staleMs).toBe(GLOBAL_DEFAULTS.refresh.staleMs)
  expect(doc.slices.get('github')?.chunkSize).toBe(10)
  expect(doc.slices.get('web')).toEqual({ ...WEB_DEFAULTS, enabled: false })
  expect(doc.problems).toEqual([])
})

test('normaliseDoc: a higher version is read-only with one problem', () => {
  const doc = normaliseDoc({ version: 2 }, SPECS)
  expect(doc.readOnly).toBe(true)
  expect(doc.version).toBe(2)
  expect(doc.problems).toEqual([
    'The file has version 2, and this mod knows version 1 only. The mod reads the file but does not change it.',
  ])
})

test('normaliseDoc: a version other than the known one is read-only, `known` is a parameter', () => {
  const lower = normaliseDoc({ version: 1 }, SPECS, 2)
  expect(lower.readOnly).toBe(true)
  expect(lower.problems).toEqual([
    'The file has version 1, and this mod knows version 2 only. The mod reads the file but does not change it.',
  ])
  expect(normaliseDoc({}, SPECS, 2).version).toBe(2)
  expect(normaliseDoc({ version: 2 }, SPECS, 2).readOnly).toBe(false)
})

test('normaliseDoc: a bad version is read as 1', () => {
  for (const [bad, shown] of [
    ['1', '"1"'],
    [0, '0'],
    [1.5, '1.5'],
    [null, 'null'],
    [-3, '-3'],
  ] as const) {
    const doc = normaliseDoc({ version: bad }, SPECS)
    expect(doc.version).toBe(1)
    expect(doc.readOnly).toBe(false)
    expect(doc.problems).toEqual([
      `version: ${shown} is not a whole number of 1 or more. The mod reads the file as version 1.`,
    ])
  }
})

test('normaliseDoc: slice problems carry the full path', () => {
  const doc = normaliseDoc({ trackers: { github: { chunkSize: 5000 } } }, SPECS)
  expect(doc.problems).toEqual(['trackers.github.chunkSize: 5000 is above the max 100. Using 100.'])
  expect(doc.slices.get('github')?.chunkSize).toBe(100)
})

test('normaliseDoc: global problems carry the global path', () => {
  const doc = normaliseDoc({ global: { tools: { breaker: { threshold: 0 } } } }, SPECS)
  expect(doc.problems).toEqual(['global.tools.breaker.threshold: 0 is below the min 1. Using 1.'])
})

test('normaliseDoc: a string number and a string boolean', () => {
  const doc = normaliseDoc(
    asObject({ global: { refresh: { tickMs: '60000' } }, trackers: { web: { enabled: 'false' } } }),
    SPECS,
  )
  expect(doc.global.refresh.tickMs).toBe(30000)
  expect(doc.slices.get('web')?.enabled).toBe(true)
  expect(doc.problems).toEqual([
    'global.refresh.tickMs: "60000" is not a number. Using 30000.',
    'trackers.web.enabled: "false" is not true or false. Using true.',
  ])
})

test('normaliseDoc: trackers.web false keeps web on with a hint', () => {
  const doc = normaliseDoc({ trackers: { web: false } }, SPECS)
  expect(doc.slices.get('web')?.enabled).toBe(true)
  expect(doc.problems).toEqual([
    'trackers.web: false is not an object. Using the defaults. To turn the tracker off, write { "enabled": false }.',
  ])
})

test('normaliseDoc: another non-object slice has no hint', () => {
  const doc = normaliseDoc({ trackers: { github: 7 } }, SPECS)
  expect(doc.slices.get('github')).toEqual(GITHUB_DEFAULTS)
  expect(doc.problems).toEqual(['trackers.github: 7 is not an object. Using the defaults.'])
})

test('normaliseDoc: a global that is not an object gives the defaults and one problem', () => {
  const doc = normaliseDoc({ global: 5 }, SPECS)
  expect(doc.global).toEqual(GLOBAL_DEFAULTS)
  expect(doc.problems).toEqual(['global: 5 is not an object. Using the defaults.'])
})

test('normaliseDoc: trackers that is not an object gives the default slices and one problem', () => {
  for (const bad of [[], 'x', null]) {
    const doc = normaliseDoc({ trackers: bad }, SPECS)
    expect(doc.slices.get('github')).toEqual(GITHUB_DEFAULTS)
    expect(doc.slices.get('web')).toEqual(WEB_DEFAULTS)
    expect(doc.problems).toEqual([`trackers: ${JSON.stringify(bad)} is not an object. Using the defaults.`])
  }
})

test('normaliseDoc: an unknown tracker id is kept and named', () => {
  const doc = normaliseDoc({ trackers: { githb: {} } }, SPECS)
  expect(doc.problems).toEqual(['trackers.githb: no tracker has this id. The mod keeps it and ignores it.'])
  expect([...doc.slices.keys()]).toEqual(['github', 'web'])
})

test('normaliseDoc: an inherited name is not a tracker slice', () => {
  const doc = normaliseDoc({ trackers: {} }, [{ id: 'constructor', config: webConfig }])
  expect(doc.slices.get('constructor')).toEqual(WEB_DEFAULTS)
  expect(doc.problems).toEqual([])
})

test('normaliseDoc: an unknown top-level key is silent, an unknown key in global is named', () => {
  expect(normaliseDoc({ $schema: 'x', note: 'hi' }, SPECS).problems).toEqual([])
  expect(normaliseDoc({ global: { refresh: { tickMss: 1 } } }, SPECS).problems).toEqual([
    'global.refresh.tickMss: unknown key. The mod keeps it and ignores it.',
  ])
})

test('normaliseDoc: problems come in order version, global, slices in spec order, unknown ids', () => {
  const doc = normaliseDoc(
    asObject({
      version: 'x',
      global: { refresh: { tickMs: 'a' } },
      trackers: { zzz: {}, web: { enabled: 1 }, github: { chunkSize: 0 } },
    }),
    SPECS,
  )
  expect(doc.problems).toEqual([
    'version: "x" is not a whole number of 1 or more. The mod reads the file as version 1.',
    'global.refresh.tickMs: "a" is not a number. Using 30000.',
    'trackers.github.chunkSize: 0 is below the min 1. Using 1.',
    'trackers.web.enabled: 1 is not true or false. Using true.',
    'trackers.zzz: no tracker has this id. The mod keeps it and ignores it.',
  ])
})

test('normaliseDoc: the result is deeply frozen', () => {
  const doc = normaliseDoc(asObject({ trackers: { github: { chunkSize: 10, extra: { deep: [1] } } } }), SPECS)
  expect(Object.isFrozen(doc)).toBe(true)
  expect(Object.isFrozen(doc.global)).toBe(true)
  expect(Object.isFrozen(doc.global.tools.breaker)).toBe(true)
  expect(Object.isFrozen(doc.problems)).toBe(true)
  const github = doc.slices.get('github') as JsonObject
  expect(Object.isFrozen(github)).toBe(true)
  expect(Object.isFrozen(github.shortRefKeywords)).toBe(true)
  expect(Object.isFrozen(github.extra)).toBe(true)
  expect(Object.isFrozen(doc.slices.get('web'))).toBe(true)
})
