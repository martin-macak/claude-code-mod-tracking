// A GitHub issue or pull request. GhTool fills the status fields in place.

import type { Checks, GitHubRecord, GitHubState, GitHubTarget, GitHubToolApi, GitHubType } from '../../hooks/contracts'
import { LIMITS } from '../../hooks/contracts'
import { omitUndefined, TrackedItem } from '../../hooks/model/tracked-item'

export class GitHubItem extends TrackedItem implements GitHubTarget {
  readonly category = 'github' as const
  host: string
  owner?: string
  repo?: string
  number: number
  type: GitHubType
  title?: string
  state?: GitHubState
  stateReason?: string
  isDraft?: boolean
  reviewDecision?: string
  checks?: Checks
  /** Discovery and a refresh set it; see `GitHubFields.closes`. */
  closes?: string[]

  constructor(
    rec: GitHubRecord,
    private readonly tool: GitHubToolApi,
  ) {
    super(rec)
    this.host = rec.host
    this.owner = rec.owner
    this.repo = rec.repo
    this.number = rec.number
    this.type = rec.type
    this.title = rec.title
    this.state = rec.state
    this.stateReason = rec.stateReason
    this.isDraft = rec.isDraft
    this.reviewDecision = rec.reviewDecision
    this.checks = rec.checks
    if (rec.closes) this.closes = [...rec.closes]
  }

  /** Needs a resolved repo, a tool that may be called, and an authed host. GHE needs a known yes. */
  canRefresh(now: number): boolean {
    if (!this.owner || !this.repo) return false
    if (!this.tool.canCall(now)) return false
    const authed = this.tool.isHostAuthed(this.host)
    return this.host.toLowerCase() === 'github.com' ? authed !== false : authed === true
  }

  async refresh(): Promise<void> {
    await this.tool.refreshItems([this])
  }

  protected override staleAfter(): number {
    return this.type === 'pr' && this.checks === 'pending' ? LIMITS.pendingStaleMs : super.staleAfter()
  }

  toRecord(): GitHubRecord {
    return omitUndefined({
      ...this.baseRecord(),
      category: 'github' as const,
      host: this.host,
      owner: this.owner,
      repo: this.repo,
      number: this.number,
      type: this.type,
      title: this.title,
      state: this.state,
      stateReason: this.stateReason,
      isDraft: this.isDraft,
      reviewDecision: this.reviewDecision,
      checks: this.checks,
      closes: this.closes === undefined ? undefined : [...this.closes],
    })
  }
}
