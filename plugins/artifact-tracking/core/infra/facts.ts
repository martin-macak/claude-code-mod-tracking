// Facts: named Json values one tracker publishes and others read. A missing fact reads as `undefined`.
// The publisher owns the name. Facts carry data, never services. No `$`.
// A publish that changes a value calls `onChange`; the manager turns that into the `fact` bus event (plan K14).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8 (Facts).

import type { FactEvent } from '../interfaces/events'
import type { Json } from '../interfaces/items'
import type { FactsPort } from '../interfaces/tracker'

/** A stored fact: the value and its text. The text is what a later publish is compared with, so an edit in place shows. */
type Held = { value: Json; text: string }

export class Facts implements FactsPort {
  private readonly values = new Map<string, Held>()

  /**
   * `onChange` runs after the store holds the new value, and it must not throw. The manager gives it the bus's `fact`
   * emit over the ports of the load: the handlers start before `publish` returns and nobody awaits them.
   */
  constructor(private readonly d: { onChange?(ev: FactEvent): void } = {}) {}

  /** A second publish replaces the first. `undefined` withdraws the fact. An equal value stores but tells nobody. */
  publish(name: string, value: Json | undefined): void {
    const previous = this.values.get(name)
    if (value === undefined) {
      if (!this.values.delete(name)) return
    } else {
      const text = JSON.stringify(value)
      this.values.set(name, { value, text })
      if (text === previous?.text) return
    }
    // `previous` is rebuilt from its text, not taken from the store: a publisher that edited the old value in place
    // would else hand the handler the new contents twice.
    this.d.onChange?.({ name, value, previous: previous && (JSON.parse(previous.text) as Json) })
  }

  read<T extends Json>(name: string): T | undefined {
    return this.values.get(name)?.value as T | undefined
  }
}
