// The tracker list: one line per tracker. A new tracker adds its line here and edits nothing in core (spec 7, OCP).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.1 and 5.8. Plan: L3 Task 8.

import type { Tracker } from '../core/interfaces/tracker'
import { processesTracker } from './processes'
import { reposTracker } from './repos'

/** What the trackers need from the wiring. Later tasks add the PR-lane deps of the auto tracker. */
export type TrackerDeps = Record<string, never>

/** The trackers of this load. Each call builds new ones, so per-load state (a breaker, a service) is not shared. */
export function buildTrackers(_deps: TrackerDeps): readonly Tracker[] {
  return [reposTracker(), processesTracker()]
}
