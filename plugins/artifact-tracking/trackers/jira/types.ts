// The record, ref and tool types of the jira tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

import type { Priority, RefreshTool } from '../../core/interfaces/items'
import type { BaseRecord, ItemError } from '../../core/lib/records'

export type JiraNode = {
  key: string
  priority?: Priority
  summary: string
  issueType: string
  status: string
  /** Jira status category key: `new`, `indeterminate` or `done`. */
  statusCategory?: string
  children: JiraNode[]
}

export type JiraFields = {
  /** Host of the URL, e.g. `acme.atlassian.net`. */
  site: string
  issueKey: string
  /** True when acli can never refresh it: a non-Cloud host. A non-active Cloud site is decided at refresh time. */
  trackOnly: boolean
  summary?: string
  issueType?: string
  status?: string
  statusCategory?: string
  children: JiraNode[]
}

export type JiraRecord = BaseRecord & { category: 'jira' } & JiraFields

export type JiraRef = {
  category: 'jira'
  site: string
  issueKey: string
  url: string
  trackOnly: boolean
}

/** A Jira item as AcliTool sees it. JiraItem implements it. */
export interface JiraTarget extends JiraFields {
  readonly key: string
  refreshedAt?: number
  error?: ItemError
}

export interface JiraToolApi extends RefreshTool<JiraTarget> {
  /** Host of acli's active site. undefined: not loaded yet. null: none (not logged in). */
  readonly activeSite: string | null | undefined
  /** Runs `acli jira auth status` and caches the site. */
  loadActiveSite(): Promise<string | null>
}
