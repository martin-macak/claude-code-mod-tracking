#!/usr/bin/env node
// project-sync: keeps the GitHub Project in step with the issues and their native
// "blocked by" links. Rules and modes: ../SKILL.md. Run with --help for the usage.
//
// Layers: core.mjs (pure rules and reports), gh.mjs (every call to gh), this file (CLI).
// Exit codes: 0 done, 1 error, 2 wrong usage, 3 the token cannot read or write the project.

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  checkFields,
  formatNext,
  formatReport,
  issueKey,
  optionsOf,
  PlanError,
  pickNext,
  plan,
  positionPlan,
  refLabel,
  withNewItem,
} from './core.mjs'
import {
  addToProject,
  applyChanges,
  applyMoves,
  GhError,
  loadBlockers,
  makeGh,
  readMilestoneIssues,
  readProject,
  resolveContent,
  setField,
} from './gh.mjs'

const DEFAULTS = { owner: 'martin-macak', project: '3', repo: 'martin-macak/claude-code-mod-tracking' }

const USAGE = `Usage: sync.mjs <command> [options]

Keeps the GitHub Project in step with the issues. Reads with gh api graphql, writes with gh api graphql and gh project.

Commands:
  sync                                     Plan Wave, Status and "Blocked by" for the open issues. A dry run: --apply writes.
  next                                     Run sync (dry run), then print the Ready item with the lowest Wave, then the lowest Order.
  add <number|url>                         Add an issue or PR to the project, set its fields, then plan as sync does.
                                           Needs --order, --area, --release. A dry run: --apply writes.
                                           A PR gets the Status "In review", unless --status says otherwise.
  status <number|"draft title"> <Status>   Set the Status of one item. Never Done: GitHub sets it.

Options:
  --owner <login>       Owner of the project. Default ${DEFAULTS.owner}.
  --project <number>    Project number. Default ${DEFAULTS.project}.
  --repo <owner/name>   Repository of the issues. Default ${DEFAULTS.repo}.
  --apply               Write the planned changes (sync, next, add). add also adds the item and sets its fields.
  --json                Print one JSON document on stdout.
  --order <n>  --area <name>  --release <name>  --status <name>   Fields for add.
  -h, --help            Show this text.

Exit codes: 0 done, 1 error, 2 wrong usage, 3 the token cannot read or write the project.`

// A stop that is not a bug: the message says what to do. code 2 is wrong usage.
class Fail extends Error {
  constructor(message, code = 1, { usage = false } = {}) {
    super(message)
    this.name = 'Fail'
    this.code = code
    this.usage = usage
  }
}
const usageError = message => new Fail(message, 2)

function parse(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        owner: { type: 'string', default: DEFAULTS.owner },
        project: { type: 'string', default: DEFAULTS.project },
        repo: { type: 'string', default: DEFAULTS.repo },
        apply: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        order: { type: 'string' },
        area: { type: 'string' },
        release: { type: 'string' },
        status: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (err) {
    throw new Fail(err.message, 2, { usage: true })
  }
  const { values, positionals } = parsed
  if (!/^[1-9]\d*$/.test(values.project))
    throw usageError(`--project must be a project number, not "${values.project}".`)
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw usageError(`--repo must look like owner/name, not "${values.repo}".`)
  return { values, positionals }
}

// "64", "#64", "owner/repo#64" or an issue or PR URL.
function parseItemRef(text, repo) {
  const t = text.trim()
  let m = /^#?(\d+)$/.exec(t)
  if (m) return { repo, number: Number(m[1]) }
  m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(t)
  if (m) return { repo: m[1], number: Number(m[2]) }
  m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/.exec(t)
  if (m) return { repo: m[1], number: Number(m[2]) }
  return null
}

function pickOption(names, wanted, field) {
  const hit = names.find(n => n.toLowerCase() === String(wanted).trim().toLowerCase())
  if (!hit) throw usageError(`"${wanted}" is not a ${field} option. ${field} options: ${names.join(', ')}.`)
  return hit
}

// Done is for GitHub: the workflows "Item closed" and "Pull request merged" set it. This check
// runs before any read, so a wrong call fails at once.
function refuseDone(wanted) {
  if (String(wanted).trim().toLowerCase() === 'done')
    throw usageError('project-sync never sets Done. GitHub sets it when the issue closes or the PR merges.')
}

const nameOf = (it, repo) => (it.kind === 'draft' ? `draft "${it.title}"` : `${refLabel(it.key, repo)} ${it.title}`)
const shown = v => (v == null ? '(empty)' : v)

function findItem(items, text, repo) {
  const ref = parseItemRef(text, repo)
  if (ref) {
    const key = issueKey(ref.repo, ref.number)
    const item = items.find(i => (i.kind === 'issue' || i.kind === 'pr') && i.key === key)
    if (!item) {
      throw new Fail(
        `${refLabel(key, repo)} is not in the project. Add it first: add ${ref.number} --order N --area A --release R.`,
      )
    }
    return item
  }
  const drafts = items.filter(i => i.kind === 'draft')
  const lower = text.trim().toLowerCase()
  // Every title contains the empty text, so an empty item would match a lone draft.
  if (lower === '') throw usageError('status needs an issue or PR number, or the title of a draft item.')
  const exact = drafts.filter(d => d.title.toLowerCase() === lower)
  const hits = exact.length > 0 ? exact : drafts.filter(d => d.title.toLowerCase().includes(lower))
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) {
    throw new Fail(`No draft item matches "${text}". Use an issue or PR number, or the title of a draft item.`)
  }
  throw new Fail(
    `"${text}" matches more than one item: ${hits.map(h => `"${h.title}"`).join('; ')}. Use more of the title.`,
  )
}

// The project, read once and checked: its fields, its items and the graph of its issues. No other call.
function readState(ctx) {
  const read = readProject(ctx.gh, { owner: ctx.owner, number: ctx.number })
  checkFields(read.fields)
  return { ...read, warnings: [], milestoneIssues: [], options: optionsOf(read.fields) }
}

// What plan() needs on top: the blockers outside the project, and the open milestone issues.
// A warning prints once per run, however often the inputs are read.
function withPlanInputs(ctx, state) {
  const warnings = loadBlockers(ctx.gh, state.graph)
  for (const w of warnings) {
    if (ctx.warned.has(w)) continue
    ctx.warned.add(w)
    ctx.stderr(`warning: ${w}`)
  }
  const milestoneIssues = readMilestoneIssues(ctx.gh, { repo: ctx.repo })
  return { ...state, warnings, milestoneIssues }
}

const load = ctx => withPlanInputs(ctx, readState(ctx)) // sync and next

const planFor = (ctx, state) =>
  plan({
    items: state.items,
    graph: state.graph,
    options: state.options,
    repo: ctx.repo,
    milestoneIssues: state.milestoneIssues,
  })

function document(ctx, state, result, done, extra = {}) {
  return {
    project: { ...state.project, owner: ctx.owner, number: ctx.number },
    repo: ctx.repo,
    apply: ctx.apply,
    changes: result.changes,
    applied: done.applied,
    positions: result.positions,
    moved: done.moved,
    positionsLeft: done.left,
    cycles: result.cycles,
    inversions: result.inversions,
    missingFromProject: result.missingFromProject,
    noStatus: result.noStatus,
    warnings: state.warnings,
    options: state.options,
    items: state.items,
    ...extra,
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// "a", "a and b", "a, b and c".
const list = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)
const writtenBefore = n => `${plural(n, 'change')} ${n === 1 ? 'was' : 'were'} written before the failure.`

// Runs writes. A gh failure in them carries `applied`: the writes that landed before (`before`),
// and those that fn did before it failed (applyChanges and applyMoves put them on the error).
// The message tells a failed write from a failed read by this.
function writing(before, fn) {
  try {
    return fn()
  } catch (err) {
    if (err instanceof GhError) err.applied = [...before, ...(Array.isArray(err.applied) ? err.applied : [])]
    throw err
  }
}

// The report, then what a dry run would write, or what was written. `lead` names what else a
// dry run would write: the new item, the field values (add).
function printReport(ctx, state, result, done, lead = []) {
  ctx.say(formatReport({ project: state.project, repo: ctx.repo, items: state.items }, result))
  if (!ctx.apply) {
    const planned = [
      ...lead,
      result.changes.length > 0 && 'changes',
      result.positions.moves.length > 0 && 'position moves',
    ].filter(Boolean)
    if (planned.length === 0) return
    ctx.say('')
    ctx.say(`Dry run: nothing was written. Pass --apply to write the planned ${list(planned)}.`)
    return
  }
  const written = [
    done.applied.length > 0 && plural(done.applied.length, 'change'),
    done.moved.length > 0 && plural(done.moved.length, 'position move'),
  ].filter(Boolean)
  if (written.length === 0) return
  ctx.say('')
  ctx.say(`Applied ${list(written)}.`)
  if (done.moved.length > 0 && done.left === 0 && done.unlisted === null)
    ctx.say('Positions checked: the manual order follows Order.')
}

// Writes the plan: the field changes first, then the position moves. A failure carries `applied`:
// everything that this run wrote before it, `before` too (the writes that came ahead of the plan).
function applyIf(ctx, state, { changes, positions }, before = []) {
  const done = { applied: [], moved: [], left: null, unlisted: null }
  if (!ctx.apply) return done
  const projectId = state.project.id
  done.applied = writing(before, () => applyChanges(ctx.gh, { projectId, fields: state.fields, changes }))
  done.moved = writing([...before, ...done.applied], () => applyMoves(ctx.gh, { projectId, moves: positions.moves }))
  return done
}

// After the moves, read the project again. The items must be in Order sequence now. `newKey` is
// the new item of add. GitHub may list a new item late (issue #107), so the read can lack it. The
// check still covers every item that the read shows. done.unlisted holds the key of a new item
// that the read lacks: its place is not checked. The read runs only after a write: when a move was
// written, or when add put in a new item, also with no move (the new item may be last already).
function checkPositions(ctx, done, newKey = null) {
  if (!ctx.apply || (done.moved.length === 0 && newKey === null)) return
  const read = readProject(ctx.gh, { owner: ctx.owner, number: ctx.number })
  done.left = positionPlan(read.items, ctx.repo).moves.length
  done.unlisted = newKey !== null && !read.items.some(isItem(newKey)) ? newKey : null
}

// The exit code after the check: 1 when an item that the read shows is still out of position.
function stillOutOfPosition(ctx, done) {
  if (done.left > 0) {
    ctx.stderr(
      `project-sync: ${plural(done.left, 'item')} ${done.left === 1 ? 'is' : 'are'} still out of position after the moves. ` +
        'Run sync again. If this repeats, GitHub orders the items in a way that this script does not expect.',
    )
    return 1
  }
  if (done.unlisted !== null) {
    // The fields are set, so the run is done. A later sync checks the place.
    ctx.stderr(
      `project-sync: ${refLabel(done.unlisted, ctx.repo)} is not in the project list yet, so its place is not checked. Run sync later.`,
    )
  }
  return 0
}

// sync and next: read, plan, write the plan when --apply is set, check the positions.
function syncRun(ctx) {
  const state = load(ctx)
  const result = planFor(ctx, state)
  const done = applyIf(ctx, state, result)
  checkPositions(ctx, done)
  return { state, result, done }
}

function cmdSync(ctx) {
  const { state, result, done } = syncRun(ctx)
  if (ctx.json) ctx.emit(document(ctx, state, result, done))
  else printReport(ctx, state, result, done)
  return stillOutOfPosition(ctx, done)
}

function cmdNext(ctx) {
  const { state, result, done } = syncRun(ctx)
  const picked = pickNext(result.effective)
  if (ctx.json) {
    ctx.emit(document(ctx, state, result, done, { next: picked.next, ready: picked.ready }))
  } else {
    printReport(ctx, state, result, done)
    ctx.say('')
    ctx.say(formatNext(picked, ctx.repo))
  }
  return stillOutOfPosition(ctx, done)
}

function cmdStatus(ctx, args) {
  if (args.length !== 2) throw usageError('status needs an item and a Status: status <number|"draft title"> <Status>.')
  refuseDone(args[1])
  const state = readState(ctx)
  const to = pickOption(state.options.Status, args[1], 'Status')
  const item = findItem(state.items, args[0], ctx.repo)
  const from = item.fields.Status
  if (from === to) {
    if (ctx.json) ctx.emit({ item, from, to, written: false })
    else ctx.say(`${nameOf(item, ctx.repo)} is already ${to}.`)
    return 0
  }
  writing([], () =>
    setField(ctx.gh, { projectId: state.project.id, itemId: item.id, field: state.fields.Status, value: to }),
  )
  if (ctx.json) ctx.emit({ item, from, to, written: true })
  else ctx.say(`${nameOf(item, ctx.repo)}: Status ${shown(from)} -> ${to}`)
  return 0
}

// The project item for an issue or PR key, if the project has one.
const isItem = key => i => i.key === key && (i.kind === 'issue' || i.kind === 'pr')

// A dry run has no project item id for a new item yet. This text stands in for it.
const NEW_ITEM_ID = '(new item)'

// add: put the item in the project, set its Order, Area and Release, then do what sync does.
// Everything is read and planned before the first write, so a dry run shows the whole plan and
// writes nothing, and a plan that cannot be made stops the run before it adds anything.
function cmdAdd(ctx, args) {
  if (args.length === 0) throw usageError('add needs an issue or PR: a number or a URL.')
  if (args.length > 1) throw usageError(`add takes one issue or PR, not ${args.length}.`)
  const ref = parseItemRef(args[0], ctx.repo)
  if (!ref) throw usageError(`"${args[0]}" is not an issue or PR number or URL.`)
  const missing = ['order', 'area', 'release'].filter(f => ctx.opts[f] === undefined)
  if (missing.length > 0) throw usageError(`add needs ${missing.map(f => `--${f}`).join(', ')}.`)
  const order = Number(ctx.opts.order)
  if (ctx.opts.order.trim() === '' || !Number.isFinite(order))
    throw usageError(`--order must be a number, not "${ctx.opts.order}".`)
  if (ctx.opts.status !== undefined) refuseDone(ctx.opts.status)

  let state = readState(ctx)
  const area = pickOption(state.options.Area, ctx.opts.area, 'Area')
  const release = pickOption(state.options.Release, ctx.opts.release, 'Release')
  const status = ctx.opts.status === undefined ? null : pickOption(state.options.Status, ctx.opts.status, 'Status')

  let key = issueKey(ref.repo, ref.number)
  let item = state.items.find(isItem(key))
  let content = null
  if (!item) {
    // An issue and a PR share the number space, so ask GitHub which one it is. GitHub also names
    // the repo as the project does, so an item that was typed in another letter case is found now.
    content = resolveContent(ctx.gh, ref)
    key = issueKey(content.repo, content.number)
    item = state.items.find(isItem(key))
  }
  const existed = item !== undefined
  if (!existed) {
    const added = withNewItem(state, content, NEW_ITEM_ID)
    item = added.item
    state = { ...state, items: added.items, graph: added.graph }
  }

  // The values to set. The item takes them now, so that the plan sees them.
  const wanted = {
    Order: order,
    Area: area,
    Release: release,
    Status: status ?? (item.kind === 'pr' && item.fields.Status == null ? 'In review' : null),
  }
  const set = {}
  const was = {}
  for (const [name, value] of Object.entries(wanted)) {
    if (value === null || item.fields[name] === value) continue
    was[name] = item.fields[name]
    set[name] = value
    item.fields[name] = value
  }
  state = withPlanInputs(ctx, state)
  let result = planFor(ctx, state)

  const written = []
  if (ctx.apply) {
    const write = (what, fn) => {
      writing(written, fn)
      written.push(what)
    }
    if (!existed) {
      // The add gives the id of the item. GitHub may list the item minutes later (issue #107), so
      // the fields are set with this id, and the run does not wait for the item in the list.
      write('item-add', () => {
        const id = addToProject(ctx.gh, { projectId: state.project.id, contentId: content.id })
        if (id === null) {
          throw new GhError(
            'other',
            `GitHub gave no item id for ${refLabel(key, ctx.repo)} when it added the item to the project.`,
          )
        }
        item.id = id
      })
    }
    for (const [name, value] of Object.entries(set)) {
      write(name, () =>
        setField(ctx.gh, { projectId: state.project.id, itemId: item.id, field: state.fields[name], value }),
      )
    }
    result = planFor(ctx, state) // the same plan, now with the id of the new item
  }
  const done = applyIf(ctx, state, result, written)
  checkPositions(ctx, done, existed ? null : key)

  const kind = item.kind === 'pr' ? 'PR' : 'issue'
  if (ctx.json) {
    // unlisted: the list lacked the new item after the moves, so its place was not checked.
    const unlisted = done.unlisted !== null
    const added = { number: ref.number, itemId: item.id, kind, title: item.title, existed, set, unlisted }
    ctx.emit(document(ctx, state, result, done, { added }))
  } else {
    const verb = existed ? 'Already in the project' : ctx.apply ? 'Added' : 'Would add'
    ctx.say(`${verb} ${nameOf(item, ctx.repo)} (${kind}).`)
    for (const [name, value] of Object.entries(set)) ctx.say(`  ${name}: ${shown(was[name])} -> ${value}`)
    ctx.say('')
    printReport(ctx, state, result, done, [!existed && 'new item', Object.keys(set).length > 0 && 'field values'])
  }
  return stillOutOfPosition(ctx, done)
}

// The token cannot read the project: say how to pick work without it.
function readFailure(ctx, err) {
  return [
    `project-sync: cannot read the GitHub Project ${ctx.number} of ${ctx.owner}.`,
    err.message,
    'Fix: run `gh auth refresh -s project`, or set GH_TOKEN to a token with the `project` scope.',
    'Unverified: a token without the `project` scope may or may not read this public project.',
    'Fallback order, without the project:',
    '  1. Take issues of the open milestone first (gh issue list --milestone "<title>").',
    `  2. Among them, skip issues with an open native blocker: gh issue view <n> --json blockedBy (gh 2.94 or newer), or on any gh: gh api repos/${ctx.repo}/issues/<n>/dependencies/blocked_by.`,
    '  3. Take the lowest issue number.',
  ].join('\n')
}

function writeFailure(ctx, err) {
  return [
    `project-sync: cannot write to the GitHub Project ${ctx.number} of ${ctx.owner}.`,
    err.message,
    writtenBefore(err.applied.length),
    'Writing needs a token with the `project` scope. Without it, report the change in the PR and leave the project alone.',
  ].join('\n')
}

// What a failed gh call prints, and the exit code. The phase comes first: did a write fail (the
// error has `applied`) or a read? The kind comes second: an auth failure has its own advice and code.
function ghFailure(ctx, err) {
  const auth = err.kind === 'auth'
  if (Array.isArray(err.applied)) {
    const text = auth
      ? writeFailure(ctx, err)
      : `project-sync: ${err.message}\n${writtenBefore(err.applied.length)} Run the command again: it plans the rest.`
    return { code: auth ? 3 : 1, text }
  }
  return auth ? { code: 3, text: readFailure(ctx, err) } : { code: 1, text: `project-sync: ${err.message}` }
}

export function main(argv, io = {}) {
  const stdout = io.stdout ?? (s => process.stdout.write(`${s}\n`))
  const stderr = io.stderr ?? (s => process.stderr.write(`${s}\n`))
  let ctx = { stderr }
  try {
    const { values, positionals } = parse(argv)
    if (values.help) {
      stdout(USAGE)
      return 0
    }
    ctx = {
      gh: io.gh ?? makeGh(),
      owner: values.owner,
      number: Number(values.project),
      repo: values.repo,
      apply: values.apply,
      json: values.json,
      opts: values,
      warned: new Set(),
      stderr,
      say: text => {
        if (!values.json) stdout(text)
      },
      emit: doc => stdout(JSON.stringify(doc, null, 2)),
    }
    const [command, ...args] = positionals
    switch (command) {
      case 'sync':
      case 'next':
        if (args.length > 0) throw usageError(`${command} takes no argument.`)
        return command === 'sync' ? cmdSync(ctx) : cmdNext(ctx)
      case 'add':
        return cmdAdd(ctx, args)
      case 'status':
        return cmdStatus(ctx, args)
      case undefined:
        throw new Fail('Give a command: sync, next, add or status.', 2, { usage: true })
      default:
        throw new Fail(`Unknown command "${command}".`, 2, { usage: true })
    }
  } catch (err) {
    if (err instanceof Fail) {
      stderr(`project-sync: ${err.message}`)
      if (err.usage) stderr(USAGE)
      return err.code
    }
    if (err instanceof PlanError) {
      stderr(`project-sync: ${err.message}`)
      return 1
    }
    if (err instanceof GhError) {
      const failure = ghFailure(ctx, err)
      stderr(failure.text)
      return failure.code
    }
    throw err
  }
}

// Run as a script, also through a symlink such as .claude/skills/project-sync.
function isMain() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}
if (isMain()) process.exitCode = main(process.argv.slice(2))
