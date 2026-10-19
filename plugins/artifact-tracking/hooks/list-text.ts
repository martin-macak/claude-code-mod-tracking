// The text of the tracking list for `/track`: the legacy composers over the view inputs. The LifecycleManager gets it as
// `LifecycleDeps.listText`, because core does not draw (K19). L6 replaces it with the text of the sections (L6 A6).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Plan: L5 Task 9.

import type { LifecycleManager } from '../core/infra/lifecycle'
import type { Ports } from '../core/interfaces/ports'
import { composeCommandText } from './ui/auto-view'
import { viewInputs } from './view-inputs'

/** The list as `/track` prints it, from the state and the facts of this load. A tracker that is off shows nothing. */
export async function listText(p: Ports, m: Pick<LifecycleManager, 'facts' | 'live'>): Promise<string> {
  const v = await viewInputs(p, m.facts, { live: id => m.live(id) })
  return composeCommandText(v.items, v.processes, v.processUi, v.ctx, v.repos)
}
