// State that lives as long as one load of the mod. A tracker is a module constant (`TRACKERS`), so what it builds once per
// load (a round, a queue, a breaker) cannot sit in a closure of the tracker: a second manager in the same process would
// share it. The key is the `facts` of the context, which core makes once per manager and gives to every tracker.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8 (Phases: a tracker builds its services once
// per load) and 10.4 (K30). Plan: L5 Task 12.

/** Anything that is one object per load. A tracker context has one: `facts`. */
export type LoadKey = { readonly facts: object }

/** One value per load. The value goes when its load is collected. */
export class LoadState<T> {
  private readonly values = new WeakMap<object, T>()

  /** The value of this load, or undefined when none was built yet. */
  get(ctx: LoadKey): T | undefined {
    return this.values.get(ctx.facts)
  }

  /** The value of this load. `make` runs once per load, at the first call. */
  of(ctx: LoadKey, make: () => T): T {
    let value = this.values.get(ctx.facts)
    if (value === undefined) {
      value = make()
      this.values.set(ctx.facts, value)
    }
    return value
  }
}
