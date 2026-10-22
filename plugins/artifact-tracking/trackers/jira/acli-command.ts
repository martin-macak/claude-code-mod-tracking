// The Jira work items that a Bash command names through `acli jira workitem <sub>`. Pure.
// Only a key that stands as an argument counts: `view KEY`, or the value of `--key`/`-k` of the sub-commands that change an item.
// Not a key: a list (`--key A-1,B-2`), a JQL query, `search`, `create`, `delete` and `link` (two keys, no `--key`).

import type { CoreReason } from '../../core/interfaces/items'
import { splitShell, stripLead } from '../../core/lib/shell'
import { JIRA_KEY } from './urls'

/** The reasons an acli command gives: it looked at the item, it changed the item, or it only named it. */
export type AcliReason = Extract<CoreReason, 'read' | 'updated' | 'mentioned'>

export type AcliWorkitem = {
  key: string
  reason: AcliReason
}

/**
 * The sub-commands that name one item by `--key`, and the reason each gives (owner decision of 2026-10-21, issue #149). A
 * command that changes the item claims `updated`. `clone` makes a new item and leaves its source alone: `mentioned`.
 * `comment` takes its own verb first: `comment list` only looks, so it is a `read`.
 */
const KEYED: ReadonlyMap<string, AcliReason> = new Map([
  ['edit', 'updated'],
  ['assign', 'updated'],
  ['transition', 'updated'],
  ['comment', 'updated'],
  ['archive', 'updated'],
  ['unarchive', 'updated'],
  ['clone', 'mentioned'],
])

/**
 * The one value of `--key`, `--key=KEY`, `-k KEY`, `-kKEY` or `-k=KEY` among the arguments. acli reads `--key` as one string
 * flag and keeps the last value of a repeated flag, so two different values name no single item. A word glued to `-k`
 * counts only when it is a key: `--body "-kind words"` is text.
 */
function keyFlag(args: readonly string[]): string | undefined {
  const values = new Set<string>()
  for (const [i, a] of args.entries()) {
    if (a === '--key' || a === '-k') {
      const v = args[i + 1]
      if (v !== undefined) values.add(v)
    } else if (a.startsWith('--key=')) values.add(a.slice('--key='.length))
    else if (a.startsWith('-k')) {
      const v = a.slice(a[2] === '=' ? 3 : 2)
      if (JIRA_KEY.test(v)) values.add(v)
    }
  }
  return values.size === 1 ? [...values][0] : undefined
}

function one(words: readonly string[]): AcliWorkitem | undefined {
  if (words[0]?.split('/').pop() !== 'acli' || words[1] !== 'jira' || words[2] !== 'workitem') return undefined
  const sub = words[3] ?? ''
  const args = words.slice(4)
  if (sub === 'view') {
    // One item only: a command with two keys among its words names no single item. The same key twice is one.
    const keys = [...new Set(args.filter(a => JIRA_KEY.test(a)))]
    return keys.length === 1 ? { key: keys[0]!, reason: 'read' } : undefined
  }
  const reason = KEYED.get(sub)
  if (reason === undefined) return undefined
  const key = keyFlag(args)
  if (key === undefined || !JIRA_KEY.test(key)) return undefined
  return { key, reason: sub === 'comment' && args[0] === 'list' ? 'read' : reason }
}

/**
 * Each work item that an `acli jira workitem` command of `command` names, in order. A repeated key repeats here. The
 * reserved words and the wrappers in front of a command (`if`, `then`, `do`, `!`, `time`, `sudo`, `env`, `VAR=x`) do not
 * hide it: `stripLead` drops them, as the other readers of `splitShell` do.
 */
export function acliWorkitems(command: string): AcliWorkitem[] {
  return splitShell(command).flatMap(seg => one(stripLead(seg).words) ?? [])
}
