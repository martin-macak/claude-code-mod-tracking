// Raw engine input and results to plain facts (spec 5.1, 7). Pure: no `$`, no I/O.
// An unknown shape gives null or an empty object, so the hooks in register.tsx hold no parsing of their own.

import { isRecord, type Json } from '../../core/lib/json'
import type { AgentResultFacts, BashFacts, EnterFacts, SpawnFacts, TurnCompleteReason } from '../../hooks/contracts'

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
 * Bash: the branch of an agent's own commit or push, and the kick reason.
 * `gitOperation.pr` kicks `pr-event`. Another operation, or a worktree or branch command, kicks `git`.
 * No result gives nothing.
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
  if (op && isRecord(op.pr)) out.kick = 'pr-event'
  else if ((op && Object.keys(op).length > 0) || GIT_CMD.test(command)) out.kick = 'git'
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
