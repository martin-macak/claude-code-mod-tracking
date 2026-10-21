// The Jira work items that a Bash command names through `acli jira workitem <sub>`. Pure.
// Only a key that stands as an argument counts: `view KEY`, or the value of `--key`/`-k` of the write sub-commands.
// Not a key: a list (`--key A-1,B-2`), a JQL query, `search`, `create`, `delete` and `link` (two keys, no `--key`).

import { splitShell } from '../../core/lib/shell'
import { JIRA_KEY } from './urls'

export type AcliWorkitem = {
  key: string
  /** `view` and `comment list` only look. Every other accepted sub-command changes the item. */
  read: boolean
}

/** The sub-commands that name one item by `--key`. `comment` takes its own verb first. */
const KEYED = new Set(['edit', 'assign', 'transition', 'clone', 'archive', 'unarchive', 'comment'])

/** The value of `--key`, `--key=KEY` or `-k` among the arguments. */
function keyFlag(args: readonly string[]): string | undefined {
  for (const [i, a] of args.entries()) {
    if (a === '--key' || a === '-k') return args[i + 1]
    if (a.startsWith('--key=')) return a.slice('--key='.length)
  }
  return undefined
}

function one(words: readonly string[]): AcliWorkitem | undefined {
  if (words[0]?.split('/').pop() !== 'acli' || words[1] !== 'jira' || words[2] !== 'workitem') return undefined
  const sub = words[3]
  const args = words.slice(4)
  if (sub === 'view') {
    const key = args.find(a => JIRA_KEY.test(a))
    return key ? { key, read: true } : undefined
  }
  if (sub === undefined || !KEYED.has(sub)) return undefined
  const key = keyFlag(args)
  if (key === undefined || !JIRA_KEY.test(key)) return undefined
  return { key, read: sub === 'comment' && args[0] === 'list' }
}

/** Each work item that an `acli jira workitem` command of `command` names, in order. A repeated key repeats here. */
export function acliWorkitems(command: string): AcliWorkitem[] {
  return splitShell(command).flatMap(seg => one(seg.words) ?? [])
}
