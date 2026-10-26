// Keeps AGENTS.md, "Planning and delivery" the only source of the planning rules (issue #66).
// A skill, an agent file or an instruction file points to the section and copies none of it.
// The README links and the two pointer files are checked here too: markdownlint (MD051)
// checks only anchors in the same file, so a heading rename would break them unseen.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const read = path => readFileSync(join(ROOT, path), 'utf8')

const HEADING = '## Planning and delivery'
const PROJECT_URL = 'https://github.com/users/martin-macak/projects/3'
// `AGENTS.md`, "Planning and delivery" in either order, or a link to the anchor.
const POINTER =
  /AGENTS\.md[^\n]{0,8}"Planning and delivery"|"Planning and delivery"[^\n]{0,8}AGENTS\.md|AGENTS\.md#planning-and-delivery/
// A file touches the plan when it names the tool, the project, the milestone or the native links.
const PLAN = /project-sync|GitHub Project|blocked-?by|milestone/i
// The shortest run of shared words that counts as a copy. 7 keeps short script rules out,
// such as "never touches In progress, In review or Done" (6 words).
const RUN = 7

// The body of the section, one entry per line, with its line number in AGENTS.md.
function sectionLines() {
  const lines = read('AGENTS.md').split('\n')
  const start = lines.indexOf(HEADING)
  assert.ok(start >= 0, `AGENTS.md has no "${HEADING}" heading.`)
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).map((text, i) => ({ text, line: start + 2 + i }))
}

// Skills, agent files and instruction files that touch the plan.
function planFiles() {
  const files = []
  for (const dir of readdirSync(join(ROOT, '.agents/skills'))) {
    const path = `.agents/skills/${dir}/SKILL.md`
    if (existsSync(join(ROOT, path))) files.push(path)
  }
  for (const dir of ['.claude/agents', '.github/agents']) {
    if (!existsSync(join(ROOT, dir))) continue
    for (const name of readdirSync(join(ROOT, dir))) if (name.endsWith('.md')) files.push(`${dir}/${name}`)
  }
  files.push('.github/copilot-instructions.md')
  return files.filter(path => PLAN.test(read(path)))
}

// Lower-case words. Markup, quotes and punctuation only split words, and a list marker is no word.
const words = text =>
  text
    .toLowerCase()
    .replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
    .replace(/[`*"“”()]/g, ' ')
    .replace(/[^a-z0-9#<>\- ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

// The anchors of the markdown links in a file that point at the root AGENTS.md. A link to another
// AGENTS.md, such as docs/AGENTS.md, does not count.
function agentsAnchors(path) {
  const dir = dirname(join(ROOT, path))
  const anchors = []
  for (const m of read(path).matchAll(/\]\(([^)#\s]+)#([^)\s]+)\)/g)) {
    if (resolve(dir, m[1]) === join(ROOT, 'AGENTS.md')) anchors.push({ path, slug: m[2] })
  }
  return anchors
}

// The anchor that GitHub gives a heading: lower case, no punctuation, spaces to hyphens,
// and -1, -2 for a heading that repeats. Headings inside a code fence do not count.
function headingSlugs(markdown) {
  const slugs = new Set()
  const seen = new Map()
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const heading = fenced ? null : /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!heading) continue
    const base = heading[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    slugs.add(n === 0 ? base : `${base}-${n}`)
  }
  return slugs
}

test('AGENTS.md has the Planning and delivery section, and it has a body', () => {
  assert.ok(sectionLines().filter(l => l.text.trim() !== '').length >= 5)
})

test('each skill and agent file that touches the plan points to the section', () => {
  const files = planFiles()
  assert.ok(files.includes('.agents/skills/project-sync/SKILL.md'), 'the file search finds the project-sync skill')
  assert.deepEqual(
    files.filter(path => !POINTER.test(read(path))),
    [],
  )
})

test('no skill or agent file copies a run of words from the section', () => {
  const runs = new Map() // a run of RUN words -> the first AGENTS.md line that has it
  for (const { text, line } of sectionLines()) {
    const w = words(text)
    for (let k = 0; k + RUN <= w.length; k += 1) {
      const run = w.slice(k, k + RUN).join(' ')
      if (!runs.has(run)) runs.set(run, line)
    }
  }
  const copies = []
  for (const path of planFiles()) {
    read(path)
      .split('\n')
      .forEach((text, i) => {
        const w = words(text)
        const hits = new Set()
        for (let k = 0; k + RUN <= w.length; k += 1) {
          const at = runs.get(w.slice(k, k + RUN).join(' '))
          if (at) hits.add(at)
        }
        for (const at of hits) copies.push(`${path}:${i + 1} copies AGENTS.md:${at}`)
      })
  }
  assert.deepEqual(copies, [])
})

test('each AGENTS.md#anchor link in the READMEs matches a heading of AGENTS.md', () => {
  const slugs = headingSlugs(read('AGENTS.md'))
  assert.ok(slugs.has('planning-and-delivery'), 'the section has the anchor planning-and-delivery')
  const links = ['README.md', 'plugins/artifact-tracking/README.md'].flatMap(agentsAnchors)
  assert.ok(links.length > 0, 'a README links an AGENTS.md anchor, or this check proves nothing')
  assert.deepEqual(
    links.filter(l => !slugs.has(l.slug)).map(l => `${l.path} links AGENTS.md#${l.slug}`),
    [],
  )
})

test('the Copilot instructions and the PR template name the section', () => {
  const missing = ['.github/copilot-instructions.md', '.github/pull_request_template.md'].filter(
    path => !read(path).includes('Planning and delivery'),
  )
  assert.deepEqual(missing, [])
})

test('both READMEs link the project', () => {
  const missing = ['README.md', 'plugins/artifact-tracking/README.md'].filter(path => !read(path).includes(PROJECT_URL))
  assert.deepEqual(missing, [])
})

// Issue #107: GitHub lists a new item late. The skill must say so where agents look for mistakes.
test('the Common mistakes table of project-sync names the late listing of a new item', () => {
  const skill = read('.agents/skills/project-sync/SKILL.md')
  const start = skill.indexOf('## Common mistakes')
  assert.ok(start >= 0, 'the skill has a Common mistakes section')
  const row = skill
    .slice(start)
    .split('\n')
    .find(line => line.startsWith('|') && /lists? a new item late/i.test(line))
  assert.ok(row, 'a row of the table names the late listing')
  assert.match(row, /add --apply/)
  assert.match(row, /item id/)
})

// Issue #107: the add row states how add --apply treats a project list that lacks the new item.
test('the add row of project-sync says that it does not wait, and how it reports an unlisted item', () => {
  const skill = read('.agents/skills/project-sync/SKILL.md')
  const row = skill.split('\n').find(line => line.startsWith('| `add <number'))
  assert.ok(row, 'the command table has an add row')
  assert.match(row, /does not wait for the item in the project list/)
  assert.match(row, /says so on stderr, exits 0/)
  assert.match(row, /`added\.unlisted: true`/)
  assert.match(row, /Run `sync` later/)
  assert.match(row, /still out of position exits 1/)
})

// The check reads the list after a move, and after the add of a new item (also with no move). The
// JSON paragraph must say when positionsLeft is null, with that exception.
test('the JSON paragraph of project-sync says when positionsLeft is null, and names the add exception', () => {
  const skill = read('.agents/skills/project-sync/SKILL.md')
  const line = skill.split('\n').find(l => l.includes('`positionsLeft` counts'))
  assert.ok(line, 'the paragraph describes positionsLeft')
  assert.match(line, /`null` when no check ran: a dry run, or a `sync` or `next` that wrote no move/)
  assert.match(line, /`add --apply` of a new item always checks, also when no move was written/)
})

// Issue #230: a stable partial list passes every check of one resolver path, so the skill names the
// second count, its path, the rule on a mismatch and its cost, where agents read the read checks.
test('the Complete reads rule of project-sync names the second count, its path and its cost', () => {
  const skill = read('.agents/skills/project-sync/SKILL.md')
  const start = skill.indexOf('- **Complete reads.**')
  assert.ok(start >= 0, 'the skill has the Complete reads rule')
  const rule = skill.slice(start, skill.indexOf('- **How positions are written.**'))
  const bullet = rule.split('\n').find(l => l.includes('**Second count.**'))
  assert.ok(bullet, 'the rule has a Second count bullet')
  assert.match(bullet, /node\(id: <project id>\) \{ \.\.\. on ProjectV2 \{ items \{ totalCount \} \} \}/)
  assert.match(bullet, /one small query per try/)
  assert.match(bullet, /refuses/)
  assert.match(bullet, /dry run warns/)
  // A node that gh cannot resolve is no count, so it makes a bad read. Any other failed call stops the run.
  assert.match(bullet, /A node that GitHub cannot resolve \(`NOT_FOUND`\) and a reply with no count both give none/)
  assert.match(bullet, /Any other failure of the query .* stops the run, as for any failed `gh` call/)
})

// Issue #107 reports a list and a count that stayed together, so the reason for no count after a
// write is not that a count runs ahead of the list. It is that nobody knows how the two agree then.
test('the After the writes rule of project-sync asks no second count and names the reason that holds', () => {
  const skill = read('.agents/skills/project-sync/SKILL.md')
  const bullet = skill.split('\n').find(l => l.includes('**After the writes.**'))
  assert.ok(bullet, 'the Complete reads rule has an After the writes bullet')
  assert.match(bullet, /It asks no second count: it is not known whether a count agrees with a list that lags after a write \(issue #107\)/)
  assert.doesNotMatch(bullet, /could include a new item/)
})
