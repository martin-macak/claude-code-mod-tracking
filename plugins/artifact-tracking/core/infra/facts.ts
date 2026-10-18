// Facts: named Json values one tracker publishes and others read. A missing fact reads as `undefined`.
// The publisher owns the name. Facts carry data, never services. No `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8 (Facts).

import type { Json } from '../interfaces/items'
import type { FactsPort } from '../interfaces/tracker'

export class Facts implements FactsPort {
  private readonly values = new Map<string, Json>()

  /** A second publish replaces the first. `undefined` withdraws the fact. */
  publish(name: string, value: Json | undefined): void {
    if (value === undefined) this.values.delete(name)
    else this.values.set(name, value)
  }

  read<T extends Json>(name: string): T | undefined {
    return this.values.get(name) as T | undefined
  }
}
