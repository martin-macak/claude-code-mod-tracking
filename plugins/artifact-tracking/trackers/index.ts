// The tracker list: one line per tracker. A new tracker adds its line here and edits nothing in core (spec 7, OCP).
// A tracker is a module constant and holds nothing per load: what it builds once per load (a round, a queue, a lane, a
// breaker) is kept per load by `LoadState`, keyed by the facts of its context (plan L5, Task 12).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.1 and 5.8. Plan: L3 Tasks 8 to 12.

import type { ItemKind } from '../core/interfaces/items'
import type { Tracker } from '../core/interfaces/tracker'
import { artifactTracker } from './artifact'
import { auto, autoDismiss } from './auto'
import { fileTracker } from './file'
import { githubTracker } from './github'
import { jiraTracker } from './jira'
import { processesTracker } from './processes'
import { reposTracker } from './repos'
import { webTracker } from './web'

/** The trackers, in the order of the spec (5.8). Core runs them by their `order`. */
export const TRACKERS: readonly Tracker[] = [
  githubTracker(),
  jiraTracker(),
  webTracker(),
  artifactTracker(),
  fileTracker(),
  reposTracker(),
  processesTracker(),
  auto,
]

/** The item kinds of the trackers. The test bindings take theirs from here. */
export const KINDS: readonly ItemKind[] = TRACKERS.flatMap(t => t.kinds ?? [])

/** The run-scoped dismiss list: the auto tracker keeps it in its slot (plan K16), and the wiring reaches it from here. */
export const DISMISS = autoDismiss

/** `owner/repo` of the session's git remote, with the host aliases of GitHub (`ssh.github.com`). The wiring reads the session with it. */
export { parseRemote } from './github'
