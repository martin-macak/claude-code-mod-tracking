// The GitHub side of the auto tracker's PR lane, over the item host. The trackers are built before the manager, and the
// manager builds the item host, so the facet looks everything up when it is called and fails with `not ready` before the
// start. It is the one place outside the trackers that joins the auto tracker to `gh`; layer L5b moves the PR lane into
// the github tracker (task 12) and deletes this file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9 (the PR lane). Plan: L5 Task 8, L3 D13.

import type { LifecycleManager } from '../core/infra/lifecycle'
import type { Json, JsonObject } from '../core/interfaces/items'
import type { Now, RepoRef } from '../core/interfaces/ports'
import type { AutoGithub } from '../trackers/auto'
import { ghOf } from '../trackers/github/client'
import { GITHUB_DEFAULTS, type GithubConfig } from '../trackers/github/config'
import type { GhTool } from '../trackers/github/gh-tool'
import type { GitHubDiscoveryApi } from './contracts'

type Host = Pick<LifecycleManager, 'items' | 'live' | 'config' | 'facts'>

export function autoGithubOf(d: { manager(): Host | undefined; now: Now }): AutoGithub {
  const slice = (m: Host): GithubConfig => ({
    ...GITHUB_DEFAULTS,
    ...(m.config.slice('github') as Partial<GithubConfig>),
  })
  const tool = (): GhTool | undefined => {
    const m = d.manager()
    const tools = m?.items.tools('github')
    return (
      m &&
      tools &&
      ghOf(tools, { slice: () => m.config.slice('github') as JsonObject, global: () => m.config.global() }, d.now)
    )
  }
  const need = (): GhTool => {
    const g = tool()
    if (!g) throw new Error('gh: not ready')
    return g
  }
  const discovery: GitHubDiscoveryApi = {
    get name() {
      return 'gh' as const
    },
    get isAvailable() {
      return tool()?.isAvailable ?? false
    },
    canCall: now => need().canCall(now),
    refreshItems: async targets => need().refreshItems(targets),
    reset: () => need().reset(),
    status: () => need().status(),
    isHostAuthed: host => need().isHostAuthed(host),
    checkHost: async host => need().checkHost(host),
    defaultRepo: async () => need().defaultRepo(),
    graphql: async (host, query) => need().graphql(host, query),
  }
  return {
    discovery,
    ready: async () => {
      const g = need()
      if (!d.manager()?.live('github')) return false // the PR lane is part of the GitHub tracker
      await g.probe()
      return g.isAvailable
    },
    repo: async () => {
      need()
      const m = d.manager()!
      await m.items.prepare()
      return (m.facts.read<Json>('session.repo') as unknown as RepoRef | undefined) ?? null
    },
    hosts: () => (d.manager()?.facts.read<Json>('github.hosts') as unknown as readonly string[] | undefined) ?? [],
    lane: () => {
      const m = d.manager()
      const { headPrsPerBranch, basePrsPerBranch, closingRefsPerPr, maxBodyRefs } = m ? slice(m) : GITHUB_DEFAULTS
      return { headPrsPerBranch, basePrsPerBranch, closingRefsPerPr, maxBodyRefs }
    },
  }
}
