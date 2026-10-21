// GLOBAL_DEFAULTS: the `global` block of the config file, as the infra reads it before any file exists. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.13.
import { expect, test } from 'claude-code/testing'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { LIMITS } from './fixtures/limits'

test('GLOBAL_DEFAULTS agrees with LIMITS where both hold a value', () => {
  expect(GLOBAL_DEFAULTS.refresh.tickMs).toBe(LIMITS.tickMs)
  expect(GLOBAL_DEFAULTS.refresh.staleMs).toBe(LIMITS.staleMs)
  expect(GLOBAL_DEFAULTS.refresh.captureDebounceMs).toBe(LIMITS.captureDebounceMs)
  expect(GLOBAL_DEFAULTS.refresh.flushMs).toBe(1500)
  expect(GLOBAL_DEFAULTS.refresh.flushMs).toBe(LIMITS.flushMs)
  expect(GLOBAL_DEFAULTS.tools.timeoutMs).toBe(LIMITS.toolTimeoutMs)
  expect(GLOBAL_DEFAULTS.tools.breaker.threshold).toBe(LIMITS.breakerThreshold)
  expect(GLOBAL_DEFAULTS.tools.breaker.openMs).toBe(LIMITS.breakerOpenMs)
  expect(GLOBAL_DEFAULTS.store.keepSessions).toBe(20)
  expect(GLOBAL_DEFAULTS.store.keepSessions).toBe(LIMITS.keepSessions)
  expect(GLOBAL_DEFAULTS.store.maxItems).toBe(LIMITS.maxItems)
  expect(GLOBAL_DEFAULTS.store.maxDismissed).toBe(LIMITS.maxDismissed)
  expect(GLOBAL_DEFAULTS.store.maxBytes).toBe(3000000)
})

test('GLOBAL_DEFAULTS holds the values of spec 5.7 that LIMITS has no twin for', () => {
  expect(GLOBAL_DEFAULTS.tools.probeTimeoutMs).toBe(10000)
  expect(GLOBAL_DEFAULTS.ui).toEqual({ maxRows: 300, sectionRows: 50, turnStrip: 'off' })
})

test('GLOBAL_DEFAULTS is frozen, also in its nested blocks', () => {
  expect(Object.isFrozen(GLOBAL_DEFAULTS)).toBe(true)
  expect(Object.isFrozen(GLOBAL_DEFAULTS.refresh)).toBe(true)
  expect(Object.isFrozen(GLOBAL_DEFAULTS.tools)).toBe(true)
  expect(Object.isFrozen(GLOBAL_DEFAULTS.tools.breaker)).toBe(true)
  expect(Object.isFrozen(GLOBAL_DEFAULTS.store)).toBe(true)
  expect(Object.isFrozen(GLOBAL_DEFAULTS.ui)).toBe(true)
})
