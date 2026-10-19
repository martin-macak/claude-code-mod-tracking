// The record and ref types of the artifact tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

import type { BaseRecord } from '../../core/lib/records'

/** Not stored: `published` when the sources hold `publish`, else `mentioned`. */
export type ArtifactOrigin = 'published' | 'mentioned'

export type ArtifactFields = {
  /** Set when this session deleted it with the Artifact tool. Sticky. */
  deleted?: true
}

export type ArtifactRecord = BaseRecord & { category: 'artifact' } & ArtifactFields

/**
 * A Claude artifact. `uuid` is the key: both URL forms of one artifact share it. `titled`: the label is the
 * page title from an Artifact publish, so it replaces the label of a known item. Else it is a Markdown label,
 * a file name or the id, and a known item keeps a better one.
 */
export type ArtifactRef = { category: 'artifact'; uuid: string; url: string; label: string; titled?: true }
