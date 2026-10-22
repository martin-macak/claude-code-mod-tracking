// Pure core of project-sync: the rules for Wave, Status and "Blocked by", and the
// reports. No IO, so the tests run on fixtures. Rules: ../SKILL.md.
//
// Inputs
//   items  Project items: { id, kind: 'issue' | 'pr' | 'draft', key, number, title, state, milestone, fields }.
//          fields = { Status, Wave, Order, Release, Area, 'Blocked by' }; null when unset.
//   graph  Issues by key "owner/repo#N": { key, id, repo, number, state, blockedBy: [keys] }.
//          It holds every open issue that an item depends on, also the ones outside the project.
//   options  Option names of the single-select fields: { Status: [...], Wave: [...] }.
//   repo   "owner/name" of the repo whose issues print as "#N".

export const NONE = '—'

const KIND_ORDER = { issue: 0, pr: 1, draft: 2, other: 3 }
const REF = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/g
const KINDS = { Issue: 'issue', PullRequest: 'pr', DraftIssue: 'draft' }
// The project fields that the script reads or writes, and the type of each.
const FIELD_TYPES = {
  Status: 'SINGLE_SELECT',
  Wave: 'SINGLE_SELECT',
  Release: 'SINGLE_SELECT',
  Area: 'SINGLE_SELECT',
  Order: 'NUMBER',
  'Blocked by': 'TEXT',
}

// A rule or a project setup that stops the run. The message tells the owner what to do.
export class PlanError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlanError'
  }
}

export const issueKey = (repo, number) => `${repo}#${number}`
export const waveName = n => `Wave ${n}`

export function waveNumber(name) {
  const m = /^Wave (\d+)$/.exec(name ?? '')
  return m ? Number(m[1]) : null
}

function splitKey(key) {
  const i = key.lastIndexOf('#')
  return { repo: key.slice(0, i), number: Number(key.slice(i + 1)) }
}

// "#55" for an issue of repo, "owner/repo#55" for an issue of another repo.
export const refLabel = (key, repo) => (key.startsWith(`${repo}#`) ? key.slice(repo.length) : key)

// Issues of repo first, then other repos by name. Ascending by number inside a repo.
function compareKeys(repo) {
  const own = k => (k.startsWith(`${repo}#`) ? 0 : 1)
  return (a, b) => {
    const x = splitKey(a)
    const y = splitKey(b)
    return own(a) - own(b) || x.repo.localeCompare(y.repo) || x.number - y.number
  }
}

// "#55 (can start when L3 merges)" gives one key. Text with no "#N" gives none.
export function parseRefs(text, repo) {
  if (typeof text !== 'string') return []
  return [...text.matchAll(REF)].map(m => issueKey(m[1] ?? repo, Number(m[2])))
}

// "#55, #62" in ascending order, or the dash when the list is empty.
export function formatRefs(keys, repo) {
  const sorted = [...new Set(keys)].sort(compareKeys(repo))
  return sorted.length > 0 ? sorted.map(k => refLabel(k, repo)).join(', ') : NONE
}

const sameSet = (a, b) => {
  const x = new Set(a)
  const y = new Set(b)
  return x.size === y.size && [...x].every(k => y.has(k))
}

function assertGraph(graph) {
  for (const node of Object.values(graph)) {
    for (const k of node.blockedBy ?? []) {
      if (!graph[k]) throw new Error(`project-sync: the issue graph has no node for ${k}, a blocker of ${node.key}.`)
    }
  }
}

// Tarjan's strongly connected components. A component is emitted after every component
// that it reaches, so the blockers of a component come out before it.
function components(nodes, edges) {
  let counter = 0
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const out = []
  const visit = v => {
    index.set(v, counter)
    low.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const w of edges(v)) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = []
      let w
      do {
        w = stack.pop()
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      out.push(comp)
    }
  }
  for (const v of nodes) if (!index.has(v)) visit(v)
  return out
}

// Wave per open issue: 0 with no open blocker, else 1 + the highest Wave of the open
// blockers. null for an issue in a cycle and for an issue that depends on a cycle.
function analyse(graph) {
  const isOpen = k => graph[k]?.state === 'OPEN'
  const blockersOf = k => (graph[k]?.blockedBy ?? []).filter(isOpen)
  const wave = new Map()
  const cycles = []
  for (const comp of components(Object.keys(graph).filter(isOpen), blockersOf)) {
    if (comp.length > 1 || blockersOf(comp[0]).includes(comp[0])) {
      cycles.push(comp)
      for (const k of comp) wave.set(k, null)
      continue
    }
    const waves = blockersOf(comp[0]).map(k => wave.get(k))
    wave.set(comp[0], waves.some(w => w === null) ? null : waves.length === 0 ? 0 : 1 + Math.max(...waves))
  }
  return { blockersOf, wave, cycles }
}

const byKind = (a, b) =>
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.number ?? 0) - (b.number ?? 0) || a.title.localeCompare(b.title)

// --- Manual order of the items ---

// The sequence that the manual order should follow: ascending Order. A tie goes issue, PR,
// draft, then by number or title. Items with no Order go last, in their current relative order.
export function desiredSequence(items) {
  const hasOrder = i => typeof i.fields.Order === 'number'
  const ordered = items.filter(hasOrder).sort((a, b) => a.fields.Order - b.fields.Order || byKind(a, b))
  return [...ordered, ...items.filter(i => !hasOrder(i))]
}

// Indexes of a longest strictly increasing subsequence of seq.
function longestIncreasing(seq) {
  const length = seq.map(() => 1)
  const prev = seq.map(() => -1)
  let best = -1
  for (let i = 0; i < seq.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (seq[j] < seq[i] && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        prev[i] = j
      }
    }
    if (best < 0 || length[i] > length[best]) best = i
  }
  const keep = new Set()
  for (let i = best; i >= 0; i = prev[i]) keep.add(i)
  return keep
}

// The fewest moves that turn the list `current` (item ids, now in position order) into `desired`.
// One move takes an item out and puts it after afterId (null: first). The items of a longest
// run that is in order already stay. The others move, in the order of `desired`, each after its
// predecessor, so each item moves once.
export function positionMoves(current, desired) {
  const rank = new Map(desired.map((id, i) => [id, i]))
  const kept = new Set([...longestIncreasing(current.map(id => rank.get(id)))].map(i => current[i]))
  return desired.flatMap((id, i) => (kept.has(id) ? [] : [{ itemId: id, afterId: i === 0 ? null : desired[i - 1] }]))
}

// `items` are in their current position order. Returns the moves, each named for the report.
export function positionPlan(items, repo) {
  const byId = new Map(items.map(i => [i.id, i]))
  const label = it => (it.key ? refLabel(it.key, repo) : `draft "${it.title}"`)
  const current = items.map(i => i.id)
  const desired = desiredSequence(items).map(i => i.id)
  const moves = positionMoves(current, desired).map(m => {
    const it = byId.get(m.itemId)
    return {
      ...m,
      kind: it.kind,
      ref: it.key ? refLabel(it.key, repo) : null,
      title: it.title,
      after: m.afterId === null ? null : label(byId.get(m.afterId)),
    }
  })
  return { total: items.length, moves }
}

// Plans the writes for the open issue items, and builds the report.
// Wave, Status and "Blocked by" are written for issues only. PRs and drafts, and closed
// issues, are left alone. Order is never written.
export function plan({ items, graph, options, repo, milestoneIssues = [] }) {
  assertGraph(graph)
  const { blockersOf, wave, cycles } = analyse(graph)
  const label = k => refLabel(k, repo)
  const needed = { Wave: new Map(), Status: new Map() }
  const need = (field, name, item) => {
    if (!needed[field].has(name)) needed[field].set(name, [])
    needed[field].get(name).push(item.number)
  }

  const changes = []
  const openIssues = items.filter(i => i.kind === 'issue' && i.state === 'OPEN').sort(byKind)
  for (const it of openIssues) {
    if (!graph[it.key]) throw new Error(`project-sync: the issue graph has no node for ${it.key}.`)
    const blockers = blockersOf(it.key)
    const push = (field, from, to) =>
      changes.push({ itemId: it.id, key: it.key, number: it.number, title: it.title, field, from: from ?? null, to })

    const w = wave.get(it.key)
    if (w !== null && w !== undefined) {
      need('Wave', waveName(w), it)
      if (it.fields.Wave !== waveName(w)) push('Wave', it.fields.Wave, waveName(w))
    }

    const status = it.fields.Status
    if (status == null || status === 'Blocked' || status === 'Ready') {
      const want = blockers.length > 0 ? 'Blocked' : 'Ready'
      if (status !== want) {
        need('Status', want, it)
        push('Status', status, want)
      }
    }

    // Keep a note whose issue numbers equal the open blockers. An empty text is always written.
    const text = it.fields['Blocked by']
    const hasText = typeof text === 'string' && text.trim() !== ''
    if (!(hasText && sameSet(parseRefs(text, repo), blockers))) push('Blocked by', text, formatRefs(blockers, repo))
  }

  const missing = []
  for (const [field, byName] of Object.entries(needed)) {
    for (const [name, numbers] of byName) {
      if (!options[field]?.includes(name)) {
        missing.push(
          `The ${field} field has no option "${name}" (needed by ${numbers.map(n => `#${n}`).join(', ')}). ` +
            `The project owner must add it: project settings, field "${field}", new option "${name}". Then run sync again.`,
        )
      }
    }
  }
  if (missing.length > 0) throw new PlanError(missing.join('\n'))

  const changed = new Map()
  for (const c of changes) changed.set(c.itemId, { ...changed.get(c.itemId), [c.field]: c.to })
  const effective = items.map(it =>
    changed.has(it.id) ? { ...it, fields: { ...it.fields, ...changed.get(it.id) } } : it,
  )

  const projectIssues = new Map(items.filter(i => i.kind === 'issue').map(i => [i.key, i]))
  const inversions = []
  for (const it of openIssues) {
    const order = it.fields.Order
    if (typeof order !== 'number') continue
    for (const k of blockersOf(it.key).sort(compareKeys(repo))) {
      const blockerOrder = projectIssues.get(k)?.fields.Order
      if (typeof blockerOrder === 'number' && order < blockerOrder) {
        inversions.push({ ref: label(it.key), order, blocker: label(k), blockerOrder })
      }
    }
  }

  const sortedCycles = cycles
    .map(comp => comp.sort(compareKeys(repo)))
    .sort((a, b) => compareKeys(repo)(a[0], b[0]))
    .map(comp => comp.map(label))

  const missingFromProject = milestoneIssues
    .filter(m => !projectIssues.has(m.key))
    .sort((a, b) => compareKeys(repo)(a.key, b.key))
    .map(m => ({ ref: label(m.key), number: m.number, title: m.title, milestone: m.milestone }))

  // Only what sync cannot fix: PRs, drafts and closed issues. The plan gives the open issues a Status.
  const noStatus = effective
    .filter(i => i.kind in KIND_ORDER && i.kind !== 'other' && i.fields.Status == null)
    .sort(byKind)
    .map(i => ({ ref: i.key ? label(i.key) : null, kind: i.kind, title: i.title }))

  return {
    changes,
    positions: positionPlan(items, repo),
    cycles: sortedCycles,
    inversions,
    missingFromProject,
    noStatus,
    effective,
  }
}

// The Ready issue or draft with the lowest Wave, then the lowest Order. PRs and closed
// issues never count. An item with no Wave or no Order comes last.
export function pickNext(items) {
  const rank = it => [
    waveNumber(it.fields.Wave) ?? Number.POSITIVE_INFINITY,
    typeof it.fields.Order === 'number' ? it.fields.Order : Number.POSITIVE_INFINITY,
    it.number ?? Number.POSITIVE_INFINITY,
  ]
  const ready = items
    .filter(it => (it.kind === 'issue' || it.kind === 'draft') && it.state !== 'CLOSED' && it.fields.Status === 'Ready')
    .sort((a, b) => {
      const x = rank(a)
      const y = rank(b)
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
      return a.title.localeCompare(b.title)
    })
  return { next: ready[0] ?? null, ready }
}

// --- Reading the project: GraphQL nodes to items and the issue graph ---

// The project must have the fields that the rules use, with the right types.
export function checkFields(fields) {
  for (const [name, type] of Object.entries(FIELD_TYPES)) {
    if (!fields[name]) {
      throw new PlanError(
        `The project has no field "${name}" (type ${type}). The project owner must add it. See SKILL.md.`,
      )
    }
    if (fields[name].dataType !== type) {
      throw new PlanError(`The field "${name}" must have the type ${type}, but it has ${fields[name].dataType}.`)
    }
  }
}

// Option names of the single-select fields.
export function optionsOf(fields) {
  const names = f => (fields[f]?.options ?? []).map(o => o.name)
  return { Status: names('Status'), Wave: names('Wave'), Release: names('Release'), Area: names('Area') }
}

const tooManyBlockers = key => new PlanError(`${key} has more than 100 blockers. project-sync reads 100 at most.`)

function graphNode(n, blockedBy) {
  const repo = n.repository.nameWithOwner
  return { key: issueKey(repo, n.number), id: n.id, repo, number: n.number, state: n.state, blockedBy }
}

// Adds a blocker that we know by id, number and state. Its own blockers are not known yet.
function addStub(graph, b) {
  const stub = graphNode(b, null)
  graph[stub.key] ??= stub
}

// projectV2: the GraphQL node, with the items of every page in items.nodes.
// Returns the project, its fields, the items and the issue graph of the project issues.
// A blocker outside the project is in the graph with blockedBy: null until mergeIssueNodes loads it.
export function normalizeProject(projectNode) {
  const fields = {}
  for (const f of projectNode.fields.nodes) {
    if (f?.name) fields[f.name] = { id: f.id, dataType: f.dataType, options: f.options ?? null }
  }
  const items = []
  const graph = {}
  for (const n of projectNode.items.nodes) {
    const c = n.content
    const kind = KINDS[c?.__typename] ?? 'other'
    const values = {}
    for (const v of n.fieldValues.nodes) {
      const name = v?.field?.name
      if (name in FIELD_TYPES) values[name] = v.name ?? v.number ?? v.text ?? null
    }
    let key = null
    if (kind === 'issue' || kind === 'pr') key = issueKey(c.repository.nameWithOwner, c.number)
    if (kind === 'issue') {
      if (c.blockedBy.pageInfo?.hasNextPage) throw tooManyBlockers(key)
      graph[key] = graphNode(
        c,
        c.blockedBy.nodes.map(b => issueKey(b.repository.nameWithOwner, b.number)),
      )
      for (const b of c.blockedBy.nodes) addStub(graph, b)
    }
    items.push({
      id: n.id,
      kind,
      key,
      repo: key ? c.repository.nameWithOwner : null,
      number: key ? c.number : null,
      title: c?.title ?? '',
      state: c?.state ?? null,
      milestone: c?.milestone ?? null,
      fields: Object.fromEntries(Object.keys(FIELD_TYPES).map(name => [name, values[name] ?? null])),
    })
  }
  return { project: { id: projectNode.id, title: projectNode.title, url: projectNode.url }, fields, items, graph }
}

// An issue or PR that is not in the project yet, as it reads right after the add: last in the
// list, with no field set. `content` is what resolveContent returns. `id` stands in for the
// project item id. An issue joins the graph with its blockers unknown, so that loadBlockers loads them.
export function withNewItem({ items, graph }, content, id) {
  const key = issueKey(content.repo, content.number)
  const item = {
    id,
    kind: content.kind,
    key,
    repo: content.repo,
    number: content.number,
    title: content.title,
    state: content.state,
    milestone: content.milestone,
    fields: Object.fromEntries(Object.keys(FIELD_TYPES).map(name => [name, null])),
  }
  const node = graphNode(
    { id: content.id, number: content.number, state: content.state, repository: { nameWithOwner: content.repo } },
    null,
  )
  return {
    item,
    items: [...items, item],
    graph: content.kind === 'issue' ? { ...graph, [key]: graph[key] ?? node } : graph,
  }
}

// --- A read that is complete (issue #228) ---
//
// GitHub's project API sometimes answers with part of the items, or with none, and says nothing
// about it: reads seconds apart gave 0, 100 and 105 items of about 109, and once totalCount itself
// said 0. A plan made from such a list is wrong, and the writes that follow it too. These checks
// say whether a read can be trusted. They take a read as readProject() returns it: `items` and
// `totalCounts` (the totalCount that each page gave, null for a page that gave none).

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// What is wrong with one read: [] when nothing is. A read is complete when the items it lists
// are all different, as many as GitHub counts (totalCount, the same on every page), and at least
// one: this project is never empty, so a list with no item is a failed read too. expectIds, when
// it is set, are the ids that an earlier read listed. A later read must list them all: items are
// added by the run itself, but none is taken away.
export function readProblems({ items, totalCounts }, { expectIds = null } = {}) {
  const problems = []
  const listed = items.length
  const counts = [...new Set(totalCounts)]
  if (totalCounts.length === 0 || counts.includes(null)) {
    problems.push('GitHub gave no item count (totalCount), so the list cannot be checked.')
  } else if (counts.length > 1) {
    problems.push(`The item count changed while the pages were read: ${totalCounts.join(', then ')}.`)
  } else if (counts[0] !== listed) {
    problems.push(`The read listed ${plural(listed, 'item')}, but GitHub counts ${counts[0]} (totalCount).`)
  }
  if (listed === 0 && problems.length === 0) problems.push('The read listed no item. This project is never empty.')
  const ids = new Set(items.map(i => i.id))
  const twice = listed - ids.size
  if (twice > 0) problems.push(`${plural(twice, 'item')} ${twice === 1 ? 'is' : 'are'} listed more than once.`)
  if (expectIds !== null) {
    const missing = [...expectIds].filter(id => !ids.has(id)).length
    if (missing > 0) {
      problems.push(`The read lacks ${missing} of the ${expectIds.size} items that the read before it listed.`)
    }
  }
  return problems
}

// What an item looks like to the plan: what the plan reads of the item and of its blockers.
const itemShape = (read, i) =>
  JSON.stringify([
    i.kind,
    i.key,
    i.state,
    i.milestone,
    i.fields,
    [...(read.graph?.[i.key]?.blockedBy ?? [])].sort(),
  ])

// What differs between two reads that came one after the other: [] when they list the same items
// with the same values. The ids are not enough: a read can list every item and still lose the
// field values or the blockers of some (a degraded nested connection), and the plan would turn that
// into writes. A real edit between two reads that come under a second apart is rare, and a retry
// is cheap. The order of the items does not count.
export function readDifferences(a, b) {
  const shapes = read => new Map(read.items.map(i => [i.id, itemShape(read, i)]))
  const [inA, inB] = [shapes(a), shapes(b)]
  const onlyA = [...inA.keys()].filter(id => !inB.has(id)).length
  const onlyB = [...inB.keys()].filter(id => !inA.has(id)).length
  const changed = [...inA].filter(([id, shape]) => inB.has(id) && inB.get(id) !== shape).length
  if (onlyA + onlyB + changed === 0) return []
  return [
    `The two reads list different items: ${a.items.length} and ${b.items.length} items, ` +
      `${onlyA} only in the first, ${onlyB} only in the second, ${changed} with other field values or blockers.`,
  ]
}

// Ids of the open issues in the graph whose blockers are not known yet.
export const unloadedOpenIds = graph =>
  Object.values(graph)
    .filter(n => n.state === 'OPEN' && n.blockedBy === null)
    .map(n => n.id)

// Loads the answer of `nodes(ids: ids)` into the graph. An issue that GitHub cannot resolve for
// this token (a null node, see issueNodes in gh.mjs) counts as open with no blockers, so the
// issues that wait for it stay Blocked. Returns warnings.
export function mergeIssueNodes(graph, nodes, ids) {
  const warnings = []
  const keyById = new Map(Object.values(graph).map(n => [n.id, n.key]))
  ids.forEach((id, i) => {
    const n = nodes[i]
    if (n?.__typename !== 'Issue') {
      const key = keyById.get(id)
      graph[key].blockedBy = []
      warnings.push(`${key} could not be read. It counts as an open issue with no blockers.`)
      return
    }
    const loaded = graphNode(
      n,
      n.blockedBy.nodes.map(b => issueKey(b.repository.nameWithOwner, b.number)),
    )
    if (n.blockedBy.pageInfo?.hasNextPage) throw tooManyBlockers(loaded.key)
    graph[loaded.key] = loaded
    for (const b of n.blockedBy.nodes) addStub(graph, b)
  })
  return warnings
}

// --- Text output ---

const MAX_MOVES_SHOWN = 10
// Cuts by code point, so that an emoji is never split.
const cut = (text, max = 60) => {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : text
}
const quote = v => (v == null ? '(empty)' : `"${v}"`)
const section = (head, lines) =>
  lines.length > 0 ? [`${head} (${lines.length}):`, ...lines.map(l => `  ${l}`)] : [`${head}: none.`]

// The report of one plan, as plain text. ctx = { project: { title, url }, repo, items }.
export function formatReport({ project, repo, items }, result) {
  const count = kind => items.filter(i => i.kind === kind).length
  const lines = [
    `Project "${project.title}": ${project.url}`,
    `Repo ${repo}. Items: ${items.length} (issues ${count('issue')}, PRs ${count('pr')}, drafts ${count('draft')}).`,
    '',
  ]
  const byItem = new Map()
  for (const c of result.changes) byItem.set(c.itemId, [...(byItem.get(c.itemId) ?? []), c])
  if (byItem.size === 0) {
    lines.push('Planned changes: none.')
  } else {
    lines.push(`Planned changes (${result.changes.length}):`)
    for (const group of byItem.values()) {
      lines.push(`  ${refLabel(group[0].key, repo)} ${cut(group[0].title)}`)
      for (const c of group) {
        const shown = v => (c.field === 'Blocked by' ? (v == null ? '(empty)' : quote(v)) : (v ?? '(empty)'))
        lines.push(`    ${c.field}: ${shown(c.from)} -> ${shown(c.to)}`)
      }
    }
  }
  const { moves, total } = result.positions
  if (moves.length === 0) {
    lines.push('Item positions: in order.')
  } else {
    lines.push(`Item positions (${moves.length} of ${total} items move to follow Order):`)
    for (const m of moves.slice(0, MAX_MOVES_SHOWN)) {
      lines.push(`  ${m.ref ?? `draft "${cut(m.title, 30)}"`} ${m.after === null ? 'to the top' : `after ${m.after}`}`)
    }
    if (moves.length > MAX_MOVES_SHOWN)
      lines.push(`  ... and ${moves.length - MAX_MOVES_SHOWN} more (--json lists all)`)
  }
  lines.push(
    ...section(
      'Cycles',
      result.cycles.map(c => c.join(', ')),
    ),
    ...section(
      'Order inversions',
      result.inversions.map(
        i => `${i.ref} (Order ${i.order}) is ordered before its blocker ${i.blocker} (Order ${i.blockerOrder})`,
      ),
    ),
    ...section(
      'Open milestone issues missing from the project',
      result.missingFromProject.map(m => `${m.ref} ${cut(m.title)} (milestone "${m.milestone}")`),
    ),
    ...section(
      'Items with no Status',
      result.noStatus.map(i => {
        const kind = { issue: 'issue', pr: 'PR', draft: 'draft' }[i.kind]
        return i.ref ? `${kind} ${i.ref} ${cut(i.title)}` : `${kind} "${cut(i.title)}"`
      }),
    ),
  )
  return lines.join('\n')
}

const place = it =>
  [
    it.fields.Wave,
    typeof it.fields.Order === 'number' ? `Order ${it.fields.Order}` : null,
    it.fields.Release ? `Release ${it.fields.Release}` : null,
    it.fields.Area ? `Area ${it.fields.Area}` : null,
  ]
    .filter(Boolean)
    .join(', ')

// The answer of pickNext, as plain text.
export function formatNext({ next, ready }, repo) {
  if (!next) return 'Next: no Ready item.'
  const lines =
    next.kind === 'issue'
      ? [`Next: ${refLabel(next.key, repo)} ${next.title}`, `  https://github.com/${next.repo}/issues/${next.number}`]
      : [`Next: draft "${next.title}"`]
  lines.push(`  ${place(next) || 'no Wave, no Order'}`)
  const others = ready.slice(1, 6).map(it => {
    const name = it.kind === 'issue' ? `${refLabel(it.key, repo)} ${cut(it.title, 40)}` : `draft "${cut(it.title, 40)}"`
    const where = [it.fields.Wave, typeof it.fields.Order === 'number' ? `Order ${it.fields.Order}` : null]
      .filter(Boolean)
      .join(', ')
    return where ? `${name} (${where})` : name
  })
  if (others.length > 0)
    lines.push(`Other Ready: ${others.join('; ')}${ready.length > 6 ? `; and ${ready.length - 6} more` : ''}`)
  return lines.join('\n')
}
