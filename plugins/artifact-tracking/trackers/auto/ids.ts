// Row ids of the auto sections (spec 6.2). An item key never starts with `wt:` or `ag:`. Build and test ids here only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 15.

export const MASTER_ID = 'ag:master'
export const worktreeId = (path: string): string => `wt:${path}`
export const agentRowId = (agentId: string): string => `ag:${agentId}`
/** The row that stands for a finished workflow run (issue #49). It is no agent: the agents of the run sit below it. */
export const workflowRowId = (runId: string): string => `ag:wf:${runId}`
/** `wf_` and the first six characters of the run id, for a label: `wf_a35565d1-fd4` shows as `wf_a35565`. */
export const shortRunId = (runId: string): string => `wf_${runId.replace(/^wf_/, '').slice(0, 6)}`
