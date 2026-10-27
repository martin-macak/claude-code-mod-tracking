// The base of a diff (issue #254, L3 of #57): which ref the diff of a file starts at. The base is the merge-base of `HEAD` with the base
// branch of the PR of the session branch, and with `origin/HEAD` when there is no such PR. The PR comes from the fact `github.branchPr`
// (`facts.ts` spells its name and shape). This file holds the policy for the names: which ones may reach a git argument, and which refs
// to try. Pure: no state, no I/O.
// Design study R15, G14: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787

import { isSafeRef } from '../../core/lib/git'

/** The refs to try for the base branch of a PR, best first: the remote branch, then the local one. A name that is not safe has none. */
export const prBaseRefs = (base: string): readonly string[] =>
  isSafeRef(base) ? [`origin/${base}`, `refs/heads/${base}`] : []

/** The name a person reads for a ref of the list above: `origin/main` as it is, `refs/heads/main` as `main`. */
export const refLabel = (ref: string): string => ref.replace(/^refs\/heads\//, '')
