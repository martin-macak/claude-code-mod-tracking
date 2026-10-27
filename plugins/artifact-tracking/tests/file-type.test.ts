// The type of a file (issue #57, R6 and R7): a fixed map of names and extensions, then the answer of
// `file --mime-type` for a name the map does not know. The 22 paths and the MIME answers are the ones of the design
// study (probe PoC, `file-type.mjs`). Pure.
import { expect, test } from 'claude-code/testing'
import { FILE_TYPES, fileTypeOf, mimeOf, typeOfMime, typeOfName } from '../trackers/file/file-type'

test('the fixed map: a name or an extension gives a type, a case never matters in an extension', () => {
  const cases: Record<string, string | undefined> = {
    'src/a.ts': 'code',
    'config.json': 'data',
    'package.json': 'config',
    'tsconfig.build.json': 'config',
    'tsconfig-base.json': 'config', // tsconfig*.json
    'tsconfig.json': 'config',
    'vite.config.ts': 'config',
    'vite.config.mts': 'config', // *.config.*
    'eslint.config.mts': 'config',
    'jest.config.cts': 'config',
    '.eslintrc.json': 'config',
    'notes.md': 'docs',
    'img.png': 'image',
    Dockerfile: 'config',
    'Dockerfile.dev': 'config',
    '.env': 'config',
    '.env.local': 'config',
    Makefile: 'code',
    'pyproject.toml': 'config',
    'pnpm-lock.yaml': 'config',
    'Cargo.lock': 'config',
    noext_script: undefined,
    'data.weird': undefined,
    'x.TS': 'code',
    'a.tar.gz': undefined,
    'nb.ipynb': 'code',
    'doc.pdf': 'docs',
  }
  for (const [path, type] of Object.entries(cases)) expect([path, typeOfName(path)]).toEqual([path, type])
})

test('the fixed map reads the last segment of a path, with either slash, and ignores a folder name', () => {
  expect(typeOfName('/work/Dockerfile/readme.txt')).toBe('docs')
  expect(typeOfName('C:\\work\\src\\a.ts')).toBe('code')
  expect(typeOfName('/work/.env.d/notes')).toBeUndefined()
  expect(typeOfName('/work/src/')).toBeUndefined()
  // A name with no dot has no extension: a file called `c`, `go` or `sh` is not C, Go or shell by its name.
  for (const bare of ['c', 'go', 'sh', 'md', 'lock', '/w/r', 'json'])
    expect([bare, typeOfName(bare)]).toEqual([bare, undefined])
  expect(typeOfName('')).toBeUndefined()
  // The names of the table are own properties: a file called like a member of Object.prototype has no type by its name.
  for (const n of ['constructor', 'toString', '__proto__', 'valueOf'])
    expect([n, typeOfName(n)]).toEqual([n, undefined])
})

test('every type has a name, and the list holds each type once, in the order the rows sort by', () => {
  expect(FILE_TYPES).toEqual(['code', 'config', 'docs', 'data', 'markup', 'image', 'other'])
  const seen = new Set<string>()
  for (const p of ['a.ts', 'a.yaml', 'a.md', 'a.csv', 'a.html', 'a.png']) seen.add(typeOfName(p) ?? '?')
  expect([...seen].sort()).toEqual(['code', 'config', 'data', 'docs', 'image', 'markup'])
})

test('typeOfMime: the answers of file --mime-type; noise and unknown types give other', () => {
  const cases: Record<string, string> = {
    'text/x-script.python': 'code',
    'text/x-shellscript': 'code',
    'text/plain': 'other',
    'image/svg+xml': 'image',
    'image/png': 'image',
    'application/json': 'data',
    'text/csv': 'data',
    'text/html': 'markup',
    'application/xml': 'markup',
    'text/xml': 'markup',
    'application/pdf': 'docs',
    'text/markdown': 'docs',
    'text/javascript': 'code',
    'application/javascript': 'code',
    'application/octet-stream': 'other',
    'inode/x-empty': 'other',
    "cannot open `nope.xyz' (No such file or directory)": 'other',
    unknown: 'other',
    '': 'other',
  }
  for (const [mime, type] of Object.entries(cases)) expect([mime, typeOfMime(mime)]).toEqual([mime, type])
})

test('mimeOf keeps a MIME type, and turns every other answer into the word unknown', () => {
  expect(mimeOf('text/x-script.python\n')).toBe('text/x-script.python')
  expect(mimeOf("  cannot open `x' (No such file or directory)\n")).toBe('unknown')
  expect(mimeOf('')).toBe('unknown')
  expect(mimeOf('a/b\nc/d')).toBe('unknown') // one line only
  expect(typeOfMime(mimeOf('garbage'))).toBe('other')
})

test('fileTypeOf: the map wins; else the cached MIME type; else other', () => {
  expect(fileTypeOf({ label: '/w/a.ts' })).toBe('code')
  expect(fileTypeOf({ label: '/w/a.ts', mime: 'image/png' })).toBe('code')
  expect(fileTypeOf({ label: '/w/script' })).toBe('other')
  expect(fileTypeOf({ label: '/w/script', mime: 'text/x-script.python' })).toBe('code')
  expect(fileTypeOf({ label: '/w/script', mime: 'unknown' })).toBe('other')
})
