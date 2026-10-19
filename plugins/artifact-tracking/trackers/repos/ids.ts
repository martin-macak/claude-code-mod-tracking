// The id of a repo row (`rp:` + the repo key). A repo key starts with `remote:` or `local:`, so it is no item key.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 14.

export const repoRowId = (key: string): string => `rp:${key}`
