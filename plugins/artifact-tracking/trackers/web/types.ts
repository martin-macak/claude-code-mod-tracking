// The record and ref types of the web tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

import type { BaseRecord } from '../../core/lib/records'

export type WebRecord = BaseRecord & { category: 'web' }

export type WebRef = { category: 'web'; url: string; label: string }
