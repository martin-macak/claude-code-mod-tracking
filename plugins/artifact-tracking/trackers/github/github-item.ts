// A GitHub issue or pull request. GhTool fills the status fields in place.

import { omitUndefined, TrackedItem } from '../../core/lib/tracked-item'
import type { Checks, GitHubRecord, GitHubState, GitHubTarget, GitHubToolApi, GitHubType } from '../../hooks/contracts'
import { GITHUB_DEFAULTS } from './config'

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
    staleMs?: () => number,
    /** How long a PR with pending checks stays current. Read at each check. */
    private readonly pendingStaleMs: () => number = () => GITHUB_DEFAULTS.pendingStaleMs,
  ) {
    super(rec, staleMs)
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
    return this.type === 'pr' && this.checks === 'pending' ? this.pendingStaleMs() : super.staleAfter()
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
