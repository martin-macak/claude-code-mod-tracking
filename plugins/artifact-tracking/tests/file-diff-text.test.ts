// The text of a diff, as the preview of a file draws it (issue #254, L3 of #57): the hunks of raw `git diff` output without its
// preamble, the binary marker, the count of changes, and the cut at the border of a hunk within the caps. `Code format="diff"` parses
// hunks, and a hunk cut in the middle with its old header does not parse, so a cut inside a hunk gets a header of the lines it keeps.
// The samples are the shapes of the design study, P4: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414685528
import { expect, test } from 'claude-code/testing'
import { changesOf, cutDiff, hunksOf, isBinaryDiff } from '../trackers/file/diff-text'

const CHANGED = `diff --git a/tracked.txt b/tracked.txt
index de98044..5d9294b 100644
--- a/tracked.txt
+++ b/tracked.txt
@@ -1,3 +1,4 @@
 a
-b
-c
+B
+C
+d
`

const DELETED = `diff --git a/del.txt b/del.txt
deleted file mode 100644
index 286c5f5..0000000
--- a/del.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
`

const UNTRACKED = `diff --git a/untracked.txt b/untracked.txt
new file mode 100644
index 0000000..07f33c4
--- /dev/null
+++ b/untracked.txt
@@ -0,0 +1,2 @@
+new
+file
`

const BINARY = `diff --git a/bin.dat b/bin.dat
index f48ba66..3d6dcf3 100644
Binary files a/bin.dat and b/bin.dat differ
`

/** A hunk of `n` added lines, starting at line `at` of the new file. */
const hunk = (at: number, n: number, tag = 'x'): string =>
  `@@ -${at},0 +${at + 1},${n} @@\n${Array.from({ length: n }, (_, i) => `+${tag}${i}`).join('\n')}\n`

test('hunksOf: the diff starts at its first hunk, so the preamble (diff, index, mode, ---, +++) is gone', () => {
  expect(hunksOf(CHANGED)).toBe('@@ -1,3 +1,4 @@\n a\n-b\n-c\n+B\n+C\n+d\n')
  expect(hunksOf(DELETED)).toBe('@@ -1 +0,0 @@\n-gone\n')
  expect(hunksOf(UNTRACKED)).toBe('@@ -0,0 +1,2 @@\n+new\n+file\n')
})

test('hunksOf: output with no hunk (empty, a binary marker, a mode change) has none, and a second file is not drawn', () => {
  expect(hunksOf('')).toBeUndefined()
  expect(hunksOf(BINARY)).toBeUndefined()
  expect(hunksOf('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toBeUndefined()
  const two = `${CHANGED}diff --git a/other.txt b/other.txt\nindex 1..2 100644\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-p\n+q\n`
  expect(hunksOf(two)).toBe('@@ -1,3 +1,4 @@\n a\n-b\n-c\n+B\n+C\n+d\n')
})

// A file that became a link (or the reverse) is two blocks of git for the one path: a deletion and an addition (m5 of the review of #289).
const TYPECHANGE = `diff --git a/f b/f
deleted file mode 100644
index 5626abf..0000000
--- a/f
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/f b/f
new file mode 120000
index 0000000..0b3c6a1
--- /dev/null
+++ b/f
@@ -0,0 +1 @@
+/etc/hosts
\\ No newline at end of file
`

test('hunksOf: a second block of the same path (a typechange) is drawn too, and the count of changes is whole', () => {
  const hunks = hunksOf(TYPECHANGE) as string
  expect(hunks).toBe('@@ -1,2 +0,0 @@\n-one\n-two\n@@ -0,0 +1 @@\n+/etc/hosts\n\\ No newline at end of file\n')
  expect(changesOf(hunks)).toEqual({ added: 1, removed: 2 })
})

test('hunksOf: a block of another path is not drawn, also when a block of the path before it has no hunk', () => {
  const other = 'diff --git a/other b/other\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n-p\n+q\n'
  expect(hunksOf(`${TYPECHANGE}${other}`)).toBe(hunksOf(TYPECHANGE))
  const modeFirst = `diff --git a/f b/f\nold mode 100644\nnew mode 100755\n${CHANGED}`
  expect(hunksOf(modeFirst)).toBe('@@ -1,3 +1,4 @@\n a\n-b\n-c\n+B\n+C\n+d\n')
})

test('hunksOf: a line of the file that looks like a header stays text of its hunk, because the body always has a prefix', () => {
  const tricky = '@@ -1,2 +1,2 @@\n+@@ -9 +9 @@\n+diff --git a/x b/x\n'
  expect(hunksOf(tricky)).toBe(tricky)
})

test('hunksOf: text before the first hunk is not drawn, also when no `diff --git` line is there to end it', () => {
  expect(hunksOf('some words\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n')).toBe('@@ -1 +1 @@\n-a\n+b\n')
})

test('isBinaryDiff: git says it in one line, or with a binary patch', () => {
  expect(isBinaryDiff(BINARY)).toBe(true)
  expect(isBinaryDiff('diff --git a/x b/x\nBinary files /dev/null and b/x differ\n')).toBe(true)
  expect(isBinaryDiff('diff --git a/x b/x\nGIT binary patch\nliteral 3\n')).toBe(true)
  expect(isBinaryDiff(CHANGED)).toBe(false)
  expect(isBinaryDiff('')).toBe(false)
  // A line of the file that says it is not git's word: the body has a prefix.
  expect(isBinaryDiff('@@ -0,0 +1 @@\n+Binary files a and b differ\n')).toBe(false)
})

test('changesOf: the added and the removed lines of the hunks, and not the ---/+++ of a file line that looks like a header', () => {
  expect(changesOf(hunksOf(CHANGED) as string)).toEqual({ added: 3, removed: 2 })
  expect(changesOf(hunksOf(DELETED) as string)).toEqual({ added: 0, removed: 1 })
  expect(changesOf('@@ -1 +1 @@\n--- a\n+++ b\n')).toEqual({ added: 1, removed: 1 })
  expect(changesOf('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n')).toEqual({
    added: 1,
    removed: 1,
  })
})

test('cutDiff: a diff within the caps is whole, and says so', () => {
  const source = hunksOf(CHANGED) as string
  expect(cutDiff(source, 100, 10_000)).toEqual({
    source,
    cut: false,
    partial: false,
    lineCut: false,
    shownLines: 7,
    totalLines: 7,
    shownHunks: 1,
    totalHunks: 1,
  })
})

test('cutDiff: over the cap of lines the cut falls on the border of a hunk, and the hunks it keeps are whole', () => {
  const source = hunk(0, 4, 'a') + hunk(10, 4, 'b') + hunk(20, 4, 'c') // 3 hunks of 5 lines
  const cut = cutDiff(source, 11, 10_000) // two hunks fit (10 lines); the third has 5 more
  expect(cut.source).toBe(hunk(0, 4, 'a') + hunk(10, 4, 'b'))
  expect(cut).toMatchObject({
    cut: true,
    partial: false,
    lineCut: false,
    shownLines: 10,
    totalLines: 15,
    shownHunks: 2,
    totalHunks: 3,
  })
})

test('cutDiff: over the cap of characters the cut falls on the border of a hunk too', () => {
  const source = hunk(0, 4, 'a') + hunk(10, 4, 'b')
  const one = hunk(0, 4, 'a').length
  const cut = cutDiff(source, 1000, one + 3)
  expect(cut.source).toBe(hunk(0, 4, 'a'))
  expect(cut).toMatchObject({ cut: true, partial: false, shownHunks: 1, totalHunks: 2 })
})

test('cutDiff: a first hunk over the cap is cut inside, and its header counts the lines that it keeps', () => {
  const source = '@@ -10,3 +10,5 @@ function f()\n a\n-b\n+B\n+C\n d\n e\n'
  // the header and two body lines fit: ` a` and `-b`
  const cut = cutDiff(source, 3, 10_000)
  expect(cut.source).toBe('@@ -10,2 +10,1 @@ function f()\n a\n-b\n')
  expect(cut).toMatchObject({
    cut: true,
    partial: true,
    lineCut: false,
    shownHunks: 1,
    totalHunks: 1,
    shownLines: 3,
    totalLines: 7,
  })
})

test('cutDiff: a cut inside a hunk keeps added lines on the new side and removed lines on the old side', () => {
  const source = '@@ -1,2 +1,4 @@\n a\n+b\n+c\n d\n'
  expect(cutDiff(source, 3, 10_000).source).toBe('@@ -1,1 +1,2 @@\n a\n+b\n')
  expect(cutDiff('@@ -1,3 +1,0 @@\n-a\n-b\n-c\n', 3, 10_000).source).toBe('@@ -1,2 +1,0 @@\n-a\n-b\n')
})

test('cutDiff: a hunk after whole ones is cut inside when a good part of the budget is left, and dropped when it is not', () => {
  const first = hunk(0, 2, 'a') // 3 lines
  const big = hunk(10, 40, 'b') // 41 lines
  const roomy = cutDiff(first + big, 20, 100_000)
  expect(roomy.source.startsWith(first)).toBe(true)
  expect(roomy.source).toContain('@@ -10,0 +11,16 @@\n') // 20 - 3 - 1 header = 16 added lines kept
  expect(roomy).toMatchObject({ cut: true, partial: true, shownHunks: 2, totalHunks: 2, shownLines: 20 })
  const tight = cutDiff(first + big, 6, 100_000) // 3 lines left: a hunk of 2 is no good view of 40
  expect(tight.source).toBe(first)
  expect(tight).toMatchObject({ cut: true, partial: false, shownHunks: 1, totalHunks: 2 })
})

test('cutDiff: a line that is longer than the cap is cut at the cap, and the hunk header still counts it', () => {
  const long = `+${'x'.repeat(500)}`
  const cut = cutDiff(`@@ -0,0 +1,2 @@\n${long}\n+tail\n`, 100, 120)
  expect(cut).toMatchObject({ lineCut: true, cut: true, partial: true })
  const [header, line, rest] = cut.source.split('\n')
  expect(header).toBe('@@ -0,0 +1,1 @@')
  expect(line?.length).toBeLessThanOrEqual(120)
  expect(line?.startsWith('+xxx')).toBe(true)
  expect(rest).toBe('')
})

test('cutDiff: the cut never splits a surrogate pair, and the source never passes the cap (the new header has a count more)', () => {
  const pair = '😀'
  const diff = `@@ -0,0 +1 @@\n+${pair.repeat(100)}\n`
  // The header is written as `@@ -0,0 +1,1 @@`: 16 characters with its newline, so a cap of 19 leaves 3 for the line and its newline.
  // Two code units are the prefix and the first half of a pair: the half goes, and the line is the prefix alone.
  const tight = cutDiff(diff, 100, 19)
  expect(tight.source).toBe('@@ -0,0 +1,1 @@\n+\n')
  expect(tight.source.length).toBeLessThanOrEqual(19)
  // A cap of 20 leaves room for the prefix and a whole pair.
  const roomy = cutDiff(diff, 100, 20)
  expect(roomy.source).toBe(`@@ -0,0 +1,1 @@\n+${pair}\n`)
  expect(roomy.source.length).toBeLessThanOrEqual(20)
})

// G13 of the design study, and the review of #289 (m6, m7, n12): the cut keeps a change in sight within the cap of characters, and the
// source never passes it. `L` is a line of 500 characters.
const L = 'x'.repeat(500)

test('cutDiff: a long changed line after context lines is cut at what is left of the cap, so the change shows (T1)', () => {
  const cut = cutDiff(`@@ -1,4 +1,4 @@\n a\n b\n c\n-${L}\n+${L}\n`, 100, 120)
  const lines = cut.source.split('\n')
  expect(lines.slice(0, 4)).toEqual(['@@ -1,4 +1,3 @@', ' a', ' b', ' c'])
  expect(lines[4]?.startsWith('-xxx')).toBe(true)
  expect(cut.source.length).toBeLessThanOrEqual(120)
  expect(cut).toMatchObject({ cut: true, partial: true, lineCut: true, shownLines: 5, totalLines: 6 })
})

test('cutDiff: the same at the default caps of the preview: a line of 70000 characters shows its start (T2)', () => {
  const huge = 'y'.repeat(70_000)
  const cut = cutDiff(`@@ -1,4 +1,4 @@\n a\n b\n c\n-${huge}\n+${huge}\n`, 2000, 60_000)
  const lines = cut.source.split('\n')
  expect(lines[4]?.startsWith('-yyy')).toBe(true)
  expect(cut.source.length).toBeLessThanOrEqual(60_000)
  expect(cut).toMatchObject({ cut: true, lineCut: true })
})

test('cutDiff: a hunk that is cut with a marker in it never passes the cap of characters, and a cut that drops nothing is no cut (T3)', () => {
  const source = '@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n'
  const whole = cutDiff(source, 100, source.length)
  expect(whole.source).toBe(source)
  expect(whole.cut).toBe(false)
  const cut = cutDiff(source, 100, source.length - 1) // one character short: the last line goes, with its marker
  expect(cut.source).toBe('@@ -1,1 +1,0 @@\n-a\n\\ No newline at end of file\n')
  expect(cut.source.length).toBeLessThanOrEqual(source.length - 1)
  expect(cut).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 2, totalLines: 3 })
})

test('cutDiff: for every cap of characters the source stays within it, and a cut with no line cut short drops a line (T3)', () => {
  const marked = '@@ -1,2 +1,2 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n'
  const mixed = `${hunk(0, 3, 'a')}${marked.replace('@@ -1,2 +1,2 @@', '@@ -8,2 +9,2 @@')}${hunk(20, 3, 'c')}`
  for (const source of [marked, hunk(0, 6, 'a'), mixed]) {
    for (let max = 20; max <= source.length + 2; max++) {
      const cut = cutDiff(source, 100, max)
      expect(cut.source.length, `a cap of ${max}`).toBeLessThanOrEqual(max)
      if (cut.cut && !cut.lineCut) expect(cut.shownLines, `a cap of ${max}`).toBeLessThan(cut.totalLines)
      if (!cut.cut) expect(cut.source, `a cap of ${max}`).toBe(source)
    }
  }
})

test('cutDiff: a cut line keeps its no-newline marker after it (T4)', () => {
  const cut = cutDiff(`@@ -1,1 +1,1 @@\n-${L}\n\\ No newline at end of file\n+b\n`, 100, 120)
  const lines = cut.source.split('\n')
  expect(lines[1]?.startsWith('-xxx')).toBe(true)
  expect(lines[2]).toBe('\\ No newline at end of file')
  expect(cut.source.length).toBeLessThanOrEqual(120)
  expect(cut).toMatchObject({ lineCut: true, partial: true })
})

test('cutDiff: a line that fits the cap alone but not after the lines before it stays out, at the border, when a change shows already', () => {
  const cut = cutDiff(`@@ -1,3 +1,3 @@\n a\n-b\n+${'z'.repeat(40)}\n c\n`, 100, 60)
  expect(cut.source).toBe('@@ -1,2 +1,1 @@\n a\n-b\n')
  expect(cut).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 3, totalLines: 5 })
})

test('cutDiff: a line that is over the cap by itself is cut short even when a change shows already', () => {
  const cut = cutDiff(`@@ -1,3 +1,3 @@\n a\n-b\n+${L}\n c\n`, 100, 60)
  const lines = cut.source.split('\n')
  expect(lines.slice(0, 3)).toEqual(['@@ -1,2 +1,2 @@', ' a', '-b'])
  expect(lines[3]?.startsWith('+xxx')).toBe(true)
  expect(cut.source.length).toBeLessThanOrEqual(60)
  expect(cut).toMatchObject({ lineCut: true, partial: true })
})

test('cutDiff: a cap too small for the header and a character still shows one character of the first line (the degenerate case)', () => {
  const cut = cutDiff(`@@ -1 +1 @@\n-${L}\n`, 100, 5)
  expect(cut.source).toBe('@@ -1,1 +1,0 @@\n-\n')
  expect(cut).toMatchObject({ cut: true, lineCut: true, shownHunks: 1 })
})

test('cutDiff: a no-newline marker stays with its line, and costs no line of the cap', () => {
  const source = '@@ -1,2 +1,2 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n'
  const whole = cutDiff(source, 3, 10_000) // header, -a, +b: the markers are free
  expect(whole.source).toBe(source)
  expect(whole.cut).toBe(false)
  const cut = cutDiff(source, 2, 10_000) // header and `-a` fit: its marker comes along, `+b` does not
  expect(cut.source).toBe('@@ -1,1 +1,0 @@\n-a\n\\ No newline at end of file\n')
})

test('cutDiff: a cap of one line still shows the header and the first line, so the hunk parses', () => {
  const cut = cutDiff('@@ -1 +1 @@\n-a\n+b\n', 1, 10_000)
  expect(cut.cut).toBe(true)
  expect(cut.source).toBe('@@ -1,1 +1,0 @@\n-a\n')
  expect(cut).toMatchObject({ shownHunks: 1, shownLines: 2, totalLines: 3 })
})

// The borders of the cut (MIN_PARTIAL, MIN_CLIP, and "over the cap by itself"): the cases above sit far from them, so each pair here
// stands on both sides of one border.
test('cutDiff: a hunk after whole ones is cut inside with exactly 5 body lines of room, and dropped with 4 (MIN_PARTIAL)', () => {
  const first = hunk(0, 2, 'a') // 3 lines
  const big = hunk(10, 40, 'b')
  const five = cutDiff(first + big, 9, 100_000) // 9 - 3 = 6 lines left: the header and 5 body lines
  expect(five.source).toBe(`${first}@@ -10,0 +11,5 @@\n+b0\n+b1\n+b2\n+b3\n+b4\n`)
  expect(five).toMatchObject({ cut: true, partial: true, shownHunks: 2, totalHunks: 2, shownLines: 9 })
  const four = cutDiff(first + big, 8, 100_000) // 5 lines left: the header and 4 body lines
  expect(four.source).toBe(first)
  expect(four).toMatchObject({ cut: true, partial: false, shownHunks: 1, totalHunks: 2, shownLines: 3 })
})

test('cutDiff: a context line then a long changed line: 2 characters left for the line show a clipped line of 2, and 1 shows none (MIN_CLIP)', () => {
  const source = `@@ -1,2 +1,2 @@\n a\n-${L}\n+${L}\n` // the header is 16 characters with its newline, ` a` takes 3: 19 are used
  const two = cutDiff(source, 100, 22) // 22 - 19 = 3: two characters of the line and its newline
  expect(two.source).toBe('@@ -1,2 +1,1 @@\n a\n-x\n')
  expect(two).toMatchObject({ cut: true, partial: true, lineCut: true, shownLines: 3, totalLines: 4 })
  const one = cutDiff(source, 100, 21) // 21 - 19 = 2: one character and its newline are no sight of the line
  expect(one.source).toBe('@@ -1,1 +1,1 @@\n a\n')
  expect(one).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 2, totalLines: 4 })
})

test('cutDiff: a line as long as all the room that a hunk has is not over the cap by itself; a character longer, it is', () => {
  // The header is 16 characters with its newline, so the cap of 28 leaves 12 for a line and its newline.
  const fits = cutDiff(`@@ -1,3 +1,3 @@\n a\n-b\n+${'z'.repeat(10)}\n c\n`, 100, 28) // `+zzzzzzzzzz` and its newline: 12
  expect(fits.source).toBe('@@ -1,2 +1,1 @@\n a\n-b\n') // it fits alone, only the lines before it keep it out: the border of the hunk
  expect(fits).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 3, totalLines: 5 })
  const over = cutDiff(`@@ -1,3 +1,3 @@\n a\n-b\n+${'z'.repeat(11)}\n c\n`, 100, 28) // 13: more than the cap can hold of a line
  expect(over.source).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+zzzz\n')
  expect(over).toMatchObject({ cut: true, partial: true, lineCut: true, shownLines: 4, totalLines: 5 })
})

// More borders of the cut, found by a single-operator mutation sweep over diff-text.ts: each test below fails when one operator or one
// constant of the code it names is changed, and passes on the code as it is.
test('cutDiff: a line that fits the cap alone but not after the context lines is cut short while no change shows yet', () => {
  // The header takes 16 characters with its newline and each context line 12: 40 are used, so 9 are left for the line and its newline.
  // The line has 21 characters and a newline, which fits the 34 that the hunk has beside its header: it is no line over the cap by itself.
  const cut = cutDiff(`@@ -1,4 +1,4 @@\n aaaaaaaaaa\n bbbbbbbbbb\n-${'x'.repeat(20)}\n+${'y'.repeat(20)}\n`, 100, 50)
  expect(cut.source).toBe('@@ -1,3 +1,2 @@\n aaaaaaaaaa\n bbbbbbbbbb\n-xxxxxxxx\n')
  expect(cut).toMatchObject({ cut: true, partial: true, lineCut: true, shownLines: 4, totalLines: 5 })
})

test('cutDiff: after a change shows, whether added or removed, the next line that fits alone stays out at the border', () => {
  // The header takes 16 characters, `+aaaaaaaaaa` 12: 28 are used, and 17 of the cap of 45 are left. The next line needs 22 and fits the
  // 29 that the hunk has beside its header, so it is no line over the cap by itself.
  const added = cutDiff(`@@ -0,0 +1,3 @@\n+aaaaaaaaaa\n+${'y'.repeat(20)}\n+z\n`, 100, 45)
  expect(added.source).toBe('@@ -0,0 +1,1 @@\n+aaaaaaaaaa\n')
  expect(added).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 2, totalLines: 4 })
  const removed = cutDiff(`@@ -1,3 +0,0 @@\n-aaaaaaaaaa\n-${'y'.repeat(20)}\n-z\n`, 100, 45)
  expect(removed.source).toBe('@@ -1,1 +0,0 @@\n-aaaaaaaaaa\n')
  expect(removed).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 2, totalLines: 4 })
})

test('cutDiff: a line that exactly fills what is left of the cap of characters is whole, and no line is cut short', () => {
  const source = '@@ -1,4 +1,4 @@\n a\n b\n-c\n+d\n' // the header takes 16 characters with its newline, each of the lines 3
  const context = cutDiff(source, 100, 22) // ` a` and ` b` end at 22: ` b` fills the cap to the last character
  expect(context.source).toBe('@@ -1,2 +1,2 @@\n a\n b\n')
  expect(context).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 3, totalLines: 5 })
  const changed = cutDiff(source, 100, 25) // `-c` ends at 25: it fills the cap to the last character
  expect(changed.source).toBe('@@ -1,3 +1,2 @@\n a\n b\n-c\n')
  expect(changed).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 4, totalLines: 5 })
})

test('cutDiff: a line is cut short when it and its no-newline marker together are over the cap by itself, and not when the line alone is not', () => {
  // The header, ` a` and `-b` use 22 characters. The line has 51 characters, 52 with its newline: it fits the 54 that the hunk has
  // beside its header, but not the 48 that are left after `-b`, so with no marker it stays out at the border. The marker adds 28.
  const line = `+${'z'.repeat(50)}`
  const marker = '\\ No newline at end of file'
  const plain = cutDiff(`@@ -1,3 +1,3 @@\n a\n-b\n${line}\n c\n`, 100, 70)
  expect(plain.source).toBe('@@ -1,2 +1,1 @@\n a\n-b\n')
  expect(plain).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 3, totalLines: 5 })
  const marked = cutDiff(`@@ -1,3 +1,3 @@\n a\n-b\n${line}\n${marker}\n c\n`, 100, 70) // 52 + 28 = 80 is more than the 54: 19 are left for the line
  expect(marked.source).toBe(`@@ -1,2 +1,2 @@\n a\n-b\n+${'z'.repeat(18)}\n${marker}\n`)
  expect(marked.source.length).toBe(70)
  expect(marked).toMatchObject({ cut: true, partial: true, lineCut: true, shownLines: 4, totalLines: 5 })
})

test('cutDiff: a cut inside a hunk keeps the lines after a no-newline marker', () => {
  // git writes this for a file `a` with no newline that became `b`, `c`: the old side ends with a marker, and the new lines follow it.
  const cut = cutDiff('@@ -1 +1,2 @@\n-a\n\\ No newline at end of file\n+b\n+c\n', 3, 10_000)
  expect(cut.source).toBe('@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n')
  expect(cut).toMatchObject({ cut: true, partial: true, lineCut: false, shownLines: 3, totalLines: 4 })
})

test('cutDiff: a hunk after a whole one is cut inside by the cap of characters that the whole one has left, not by the whole cap', () => {
  const first = hunk(0, 2, 'a') // 24 characters
  const big = hunk(10, 12, 'b') // the cut counts its header as it is whole, 19 characters (the one that is written has 18), and each line 4
  const six = cutDiff(first + big, 100, 24 + 19 + 6 * 4) // 67: six lines fit what is left, a seventh needs 4 more
  expect(six.source).toBe(`${first}@@ -10,0 +11,6 @@\n+b0\n+b1\n+b2\n+b3\n+b4\n+b5\n`)
  expect(six).toMatchObject({ cut: true, partial: true, lineCut: false, shownHunks: 2, totalHunks: 2, shownLines: 10 })
  const seven = cutDiff(first + big, 100, 24 + 19 + 7 * 4) // 71
  expect(seven.source).toBe(`${first}@@ -10,0 +11,7 @@\n+b0\n+b1\n+b2\n+b3\n+b4\n+b5\n+b6\n`)
  expect(seven).toMatchObject({
    cut: true,
    partial: true,
    lineCut: false,
    shownHunks: 2,
    totalHunks: 2,
    shownLines: 11,
  })
})

test('cutDiff: a hunk that is dropped at its border ends the diff, and a smaller hunk after it does not take its place', () => {
  const first = hunk(0, 2, 'a') // 3 lines
  const cut = cutDiff(first + hunk(10, 40, 'b') + hunk(60, 1, 'c'), 7, 100_000) // 4 lines are left for the big hunk: no good view
  expect(cut.source).toBe(first)
  expect(cut).toMatchObject({ cut: true, partial: false, shownHunks: 1, totalHunks: 3, shownLines: 3 })
})

test('cutDiff: a hunk that is cut inside ends the diff, and a small hunk after it does not follow', () => {
  // The second line fits the cap alone (32 of the 33 that the hunk has beside its header) but not after the first: it stays out, and
  // the room that is left would still hold the small hunk at the end.
  const wide = `@@ -0,0 +1,3 @@\n+a\n+${'q'.repeat(30)}\n+z\n`
  const small = '@@ -50,0 +51,1 @@\n+c\n'
  const cut = cutDiff(wide + small, 100, 49)
  expect(cut.source).toBe('@@ -0,0 +1,1 @@\n+a\n')
  expect(cut).toMatchObject({ cut: true, partial: true, lineCut: false, shownHunks: 1, totalHunks: 2, shownLines: 2 })
})
