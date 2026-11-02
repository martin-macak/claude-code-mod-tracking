// A KB page links to a line of repo code with `#L<n>`. A PR that adds or removes lines above the linked line moves the line
// and the link opens the wrong one (issue #250). Nothing else fails then, so this test does. Each such link carries a title
// with a short excerpt of the line it names: `[shell.ts:199](../shell.ts#L199 "export function splitShell")`. The excerpt
// must start the first linked line (after its indent) and must not contain `"`. It must come from the line that the
// sentence relies on, and it must name that line alone in its file. The end line of a range is not checked, only that it
// is inside the file. A link whose target is missing fails. A link into `plugins/example/` is a doc example and is skipped. A PR that moves the line fails here until the link is remapped. A link into
// `sources/` points at a vendored file that does not change, so it is out of scope. A link with no `#L` is out of scope too.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/kb-code-links.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const KB = path.join(ROOT, 'docs/knowledge-base')

/** Every `.md` file under `dir`, without the vendored `sources/` folders. */
function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'sources' || e.name === 'node_modules' ? [] : pages(full)
    return e.name.endsWith('.md') ? [full] : []
  })
}

// `[text](relative/path#L12 "excerpt")` or `#L12-L20`. The title is optional here: a missing one is a finding.
const LINK = /\[([^\]]*)\]\(((?:\.\.?\/)[^)\s#]*)#L(\d+)(?:-L(\d+))?(?:\s+"([^"]*)")?\)/g

/** True for a file under `plugins/example/`, the placeholder plugin of the docs. The real examples under the KB are checked. */
function isDocExample(target) {
  return target.startsWith(`${path.join(ROOT, 'plugins/example')}${path.sep}`)
}

/** The links of `text` into repo files that are not vendored, with the line of the page. */
export function codeLinks(file, text) {
  const found = []
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(LINK)) {
      const target = path.resolve(path.dirname(file), m[2])
      const segments = target.split(path.sep)
      if (segments.includes('sources') || isDocExample(target)) continue
      found.push({
        at: `${path.relative(ROOT, file)}:${i + 1}`,
        text: m[1],
        target,
        rel: path.relative(ROOT, target),
        from: Number(m[3]),
        to: m[4] === undefined ? undefined : Number(m[4]),
        title: m[5],
      })
    }
  })
  return found
}

/** The `#L` anchors of `text` that the scan must parse: every relative link with a line, minus the skipped targets. */
export function anchorCount(file, text) {
  return [...text.matchAll(/\]\(((?:\.\.?\/)[^)\s#]*)#L\d/g)].filter(m => {
    const target = path.resolve(path.dirname(file), m[1])
    return !target.split(path.sep).includes('sources') && !isDocExample(target)
  }).length
}

const MIN_TITLE = 8

/** The findings for one link, given the lines of its target file. An empty list means the link is right. */
export function checkLink(l, lines) {
  const at = `${l.at} ${l.rel}#L${l.from}`
  if (lines === undefined) return [`${at} the target file is missing`]
  const title = l.title?.trim()
  if (!title) return [`${at} has no title: add the start of the linked line, [text](path#L12 "const x = 1")`]
  if (title.length < MIN_TITLE || /^[/*\s]*$/.test(title))
    return [`${at} "${l.title}" is too generic: use at least ${MIN_TITLE} characters of code or text`]
  const found = []
  const line = lines[l.from - 1]
  if (line === undefined || !line.trimStart().startsWith(title)) {
    const now = lines.findIndex(x => x.trimStart().startsWith(title)) + 1
    found.push(`${at} "${l.title}" ${now ? `is now on line ${now}` : 'is gone'}`)
  } else if (lines.filter(x => x.trimStart().startsWith(title)).length > 1) {
    found.push(`${at} "${l.title}" starts more than one line: use a longer excerpt`)
  }
  if (l.to !== undefined && (l.to < l.from || l.to > lines.length))
    found.push(`${at} range to L${l.to} is out of the file`)
  return found
}

const links = pages(KB).flatMap(f => codeLinks(f, readFileSync(f, 'utf8')))
const linesOf = target => (existsSync(target) ? readFileSync(target, 'utf8').split('\n') : undefined)
const PROCESS_PAGE = 'docs/knowledge-base/claude-code-mods/concepts/process-tracking-signals.md'

test('the scan finds every KB link into repo code', () => {
  assert.ok(
    links.some(l => l.at.startsWith(`${PROCESS_PAGE}:`)),
    `the scan found no link in ${PROCESS_PAGE}, which links repo code`,
  )
  const anchors = pages(KB).reduce((n, f) => n + anchorCount(f, readFileSync(f, 'utf8')), 0)
  assert.equal(links.length, anchors, 'a link with an #L anchor is not parsed: check its title, it must not contain "')
})

test('the anchor count sees a link that the scan cannot parse', () => {
  const file = path.join(KB, 'x.md')
  const odd = '[a](../../plugins/artifact-tracking/shell.ts#L1 "say "hi"")'
  assert.equal(codeLinks(file, odd).length, 0)
  assert.equal(anchorCount(file, odd), 1)
  const skipped = '[a](../claude-code-mods/sources/x/y.md#L1) [b](../../plugins/example/s.ts#L1 "export function")'
  assert.equal(anchorCount(file, skipped), 0)
  const ok = '[a](../../plugins/none/gone.ts#L1 "export function")'
  assert.equal(anchorCount(file, ok), codeLinks(file, ok).length)
})

test('every KB link into repo code names the line it points to by an excerpt in its title', () => {
  const bad = links.flatMap(l => checkLink(l, linesOf(l.target)))
  assert.deepEqual(bad, [], 'remap the link to the line that holds the excerpt')
})

test('a line number in the link text equals the line of the anchor', () => {
  const bad = []
  for (const l of links) {
    const m = /(?:^|[:L])(\d+)(?:-(\d+))?$/.exec(l.text)
    if (!m) continue
    if (Number(m[1]) !== l.from || (m[2] !== undefined && Number(m[2]) !== l.to))
      bad.push(`${l.at} [${l.text}] names L${l.from}${l.to ? `-L${l.to}` : ''}`)
  }
  assert.deepEqual(bad, [])
})

test('the check catches a link that moved, has no title or a generic one, or has a missing target', () => {
  const link = over => ({ at: 'x.md:1', rel: 'a.ts', from: 2, to: undefined, title: 'const beta = 2', ...over })
  const lines = ['const alpha = 1', 'const beta = 2', 'const gamma = 3']
  assert.deepEqual(checkLink(link({}), lines), [])
  assert.match(checkLink(link({ from: 1 }), lines)[0], /is now on line 2/)
  assert.match(checkLink(link({ from: 3 }), lines)[0], /is now on line 2/)
  assert.match(checkLink(link({ title: 'const gone = 9' }), lines)[0], /is gone/)
  assert.match(checkLink(link({ title: undefined }), lines)[0], /has no title/)
  assert.match(checkLink(link({ title: '/**' }), lines)[0], /too generic/)
  assert.match(checkLink(link({ title: 'const' }), lines)[0], /too generic/)
  assert.match(
    checkLink(link({ from: 1, title: 'const alpha' }), ['const alpha = 1', 'const alpha = 2'])[0],
    /more than one line/,
  )
  assert.match(checkLink(link({ from: 1, to: 9, title: 'const alpha = 1' }), lines)[0], /out of the file/)
  assert.match(checkLink(link({}), undefined)[0], /target file is missing/)
})

test('the scan skips a link into sources/ and a doc example, and keeps a link to a missing file', () => {
  const file = path.join(KB, 'x.md')
  assert.deepEqual(codeLinks(file, '[a](../claude-code-mods/sources/x/y.md#L1)'), [])
  assert.deepEqual(codeLinks(file, '[a](../../plugins/example/shell.ts#L1 "export function")'), [])
  const real = '[a](../claude-code-link-capture/example/link-capture/hooks/register.ts#L1 "export function")'
  assert.equal(codeLinks(file, real).length, 1)
  assert.equal(anchorCount(file, real), 1)
  const [gone] = codeLinks(file, '[a](../../plugins/none/gone.ts#L1 "export function")')
  assert.equal(gone.rel, 'plugins/none/gone.ts')
  assert.match(checkLink(gone, linesOf(gone.target))[0], /target file is missing/)
})
