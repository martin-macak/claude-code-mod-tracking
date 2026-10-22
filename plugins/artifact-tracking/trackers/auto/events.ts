// Raw engine input and results to plain facts (spec 5.1, 7). Pure: no `$`, no I/O.
// An unknown shape gives null or an empty object, so the hooks in register.tsx hold no parsing of their own.

import { isRecord, type Json } from '../../core/lib/json'
import type { AgentResultFacts, BashFacts, EnterFacts, PrFacts, SpawnFacts, TurnCompleteReason } from './types'

/** A shell command that can change worktrees or branches. `echo git` does not match. */
export const GIT_CMD = /\bgit\s+(?:-C\s+\S+\s+)?(?:worktree|checkout|switch|branch)\b/

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const REASONS = new Set<string>(['answer', 'aborted', 'error', 'refusal'])

/** The `result` of `await next(e)` for a tool.call. */
const resultOf = (ran: unknown): Json | null => (isRecord(ran) && isRecord(ran.result) ? ran.result : null)

/** EnterWorktree result: `worktreePath`, `worktreeBranch`. null when `ran` has no result. */
export function fromEnterResult(ran: unknown, agentId?: string): EnterFacts | null {
  const r = resultOf(ran)
  const path = str(r?.worktreePath)
  if (!r || path === undefined) return null
  const branch = str(r.worktreeBranch)
  return { path, ...(branch !== undefined ? { branch } : {}), ...(agentId !== undefined ? { agentId } : {}) }
}

/** Agent result: `completed` has the path and branch, `async_launched` has the id only. */
export function fromAgentResult(ran: unknown): AgentResultFacts | null {
  const r = resultOf(ran)
  const agentId = str(r?.agentId)
  if (!r || agentId === undefined) return null
  if (r.status === 'async_launched') return { agentId }
  if (r.status !== 'completed') return null
  const worktreePath = str(r.worktreePath)
  const worktreeBranch = str(r.worktreeBranch)
  return {
    agentId,
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
  }
}

/** The `agent.spawn` input plus the `next(e)` answer. null when the answer has no agent id. */
export function fromSpawn(input: unknown, answer: unknown): SpawnFacts | null {
  if (!isRecord(input) || !isRecord(answer)) return null
  const agentId = str(answer.agentId)
  if (agentId === undefined) return null
  const name = str(input.name)
  const parentAgentId = str(input.parentAgentId)
  const cwd = str(input.cwd)
  const wf = input.workflow
  const runId = isRecord(wf) ? str(wf.runId) : undefined
  const index = isRecord(wf) && typeof wf.agentIndex === 'number' ? wf.agentIndex : undefined
  return {
    agentId,
    description: str(input.description) ?? '',
    subagentType: str(input.subagentType) ?? '',
    ...(name !== undefined ? { name } : {}),
    ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    ...(runId !== undefined && index !== undefined ? { workflow: { runId, agentIndex: index } } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  }
}

/**
 * The path of a pull request URL, with its tail: `/<owner>/<repo>/pull/<n>`, then nothing, or a `/`, `?` or `#` and more.
 * It is the pull half of `GH_PATH` in `trackers/github/urls.ts` and must read the same URLs: a tracker imports no other
 * tracker, and `core` may not name one, so there is no shared home for the pattern. `tests/pr-url-parity.test.ts` fails
 * when the two drift apart.
 */
const PR_PATH = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/

/**
 * The PR that a `gitOperation.pr` made: its host, owner, repo and number, read from the URL. The case of owner and repo
 * stays as written. Only the action `created` counts, and the number of the operation must be the one in the URL. The host
 * is any host: the proof says the session made the PR, and the lane decides whether `gh` can ask for it.
 */
function createdPr(pr: Json): PrFacts | undefined {
  if (pr.action !== 'created' || typeof pr.url !== 'string') return undefined
  let u: URL
  try {
    u = new URL(pr.url.trim())
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  const m = PR_PATH.exec(u.pathname + u.search + u.hash)
  if (!m) return undefined
  const number = Number(m[3])
  if (!Number.isSafeInteger(number) || (typeof pr.number === 'number' && pr.number !== number)) return undefined
  const host = u.hostname.toLowerCase()
  return { host: host === 'www.github.com' ? 'github.com' : host, owner: m[1]!, repo: m[2]!, number }
}

/**
 * Bash: the branch of an agent's own commit or push, the PR the command created, and the kick reason.
 * `gitOperation.pr` kicks `pr-event`; a created one is also a proof (`pr`). Another operation, or a worktree or branch
 * command, kicks `git`. No result gives nothing.
 */
export function fromBash(command: string, ran: unknown, agentId?: string): BashFacts {
  const r = resultOf(ran)
  if (!r) return {}
  const op = isRecord(r.gitOperation) ? r.gitOperation : undefined
  const out: BashFacts = {}
  if (agentId !== undefined && op) {
    const commit = isRecord(op.commit) ? str(op.commit.branch) : undefined
    const push = isRecord(op.push) ? str(op.push.branch) : undefined
    const branch = commit ?? push
    if (branch !== undefined) {
      out.agentId = agentId
      out.branch = branch
    }
  }
  if (op && isRecord(op.pr)) {
    out.kick = 'pr-event'
    const pr = createdPr(op.pr)
    if (pr) out.pr = pr
  } else if ((op && Object.keys(op).length > 0) || GIT_CMD.test(command)) out.kick = 'git'
  return out
}

/** turn.complete with an agent id. The main loop (no id) gives null. */
export function fromTurnEnd(e: unknown): { agentId: string; reason: TurnCompleteReason } | null {
  if (!isRecord(e)) return null
  const agentId = str(e.agentId)
  const reason = e.reason
  if (agentId === undefined || typeof reason !== 'string' || !REASONS.has(reason)) return null
  return { agentId, reason: reason as TurnCompleteReason }
}
