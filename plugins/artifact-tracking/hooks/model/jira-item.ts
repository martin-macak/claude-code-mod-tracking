// A Jira work item. AcliTool fills the status fields and the child tree in place.

import { JIRA_KEY } from '../contracts'
import type { JiraNode, JiraRecord, JiraTarget, JiraToolApi } from '../contracts'
import { omitUndefined, TrackedItem } from './tracked-item'

/** Deep copy of a child tree. */
export function cloneNodes(nodes: readonly JiraNode[]): JiraNode[] {
  return nodes.map((n) => omitUndefined({ ...n, children: cloneNodes(n.children) }))
}

export class JiraItem extends TrackedItem implements JiraTarget {
  readonly category = 'jira' as const
  site: string
  issueKey: string
  trackOnly: boolean
  summary?: string
  issueType?: string
  status?: string
  statusCategory?: string
  children: JiraNode[]

  constructor(rec: JiraRecord, private readonly tool: JiraToolApi) {
    super(rec)
    this.site = rec.site
    this.issueKey = rec.issueKey
    this.trackOnly = rec.trackOnly
    this.summary = rec.summary
    this.issueType = rec.issueType
    this.status = rec.status
    this.statusCategory = rec.statusCategory
    this.children = cloneNodes(rec.children)
  }

  /** acli works on its active site only. `undefined` means not loaded yet: try, the tool checks. */
  canRefresh(now: number): boolean {
    if (this.trackOnly || !JIRA_KEY.test(this.issueKey)) return false
    const active = this.tool.activeSite
    if (active === null) return false
    if (active !== undefined && active.toLowerCase() !== this.site.toLowerCase()) return false
    return this.tool.canCall(now)
  }

  async refresh(): Promise<void> {
    await this.tool.refreshItems([this])
  }

  toRecord(): JiraRecord {
    return omitUndefined({
      ...this.baseRecord(),
      category: 'jira' as const,
      site: this.site,
      issueKey: this.issueKey,
      trackOnly: this.trackOnly,
      summary: this.summary,
      issueType: this.issueType,
      status: this.status,
      statusCategory: this.statusCategory,
      children: cloneNodes(this.children),
    })
  }
}
