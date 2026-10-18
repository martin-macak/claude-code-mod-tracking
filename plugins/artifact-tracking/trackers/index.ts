// The tracker list: one line per tracker. A new tracker adds its line here and edits nothing in core (spec 7, OCP).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.1 and 5.8. Plan: L3 Tasks 8 to 12.

import type { Tracker } from '../core/interfaces/tracker'
import { type AutoGithub, autoTracker } from './auto'
import { githubTracker } from './github'
import { jiraTracker } from './jira'
import { processesTracker } from './processes'
import { reposTracker } from './repos'
import { webTracker } from './web'

/** What the trackers need from the wiring. */
export type TrackerDeps = {
  /** The GitHub side of the PR lane of the auto tracker (plan decision D13). */
  autoGithub: AutoGithub
}

/** The trackers of this load. Each call builds new ones, so per-load state (a breaker, a service) is not shared. */
export function buildTrackers(deps: TrackerDeps): readonly Tracker[] {
  return [
    githubTracker(),
    jiraTracker(),
    webTracker(),
    reposTracker(),
    processesTracker(),
    autoTracker(deps.autoGithub),
  ]
}
