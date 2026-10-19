// Row ids of the auto sections (spec 6.2). An item key never starts with `wt:` or `ag:`. Build and test ids here only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 15.

export const MASTER_ID = 'ag:master'
export const worktreeId = (path: string): string => `wt:${path}`
export const agentRowId = (agentId: string): string => `ag:${agentId}`
