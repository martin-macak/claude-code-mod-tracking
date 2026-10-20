// The display name of a process row (issue #49, PR 2): a word of the command that starts with the session root shows from
// `./`. The stored name and the fingerprint stay as they are. Pure.
import { expect, test } from 'claude-code/testing'
import { fromRoot } from '../trackers/processes/names'

test('a path under the root shows from ./', () => {
  expect(fromRoot('/work/scripts/serve.sh', '/work')).toBe('./scripts/serve.sh')
  expect(fromRoot('node /work/server.js --port 3000', '/work')).toBe('node ./server.js --port 3000')
})

test('every word that starts with the root is shortened, in a flag value and in quotes too', () => {
  expect(fromRoot('cp /work/a /work/b', '/work')).toBe('cp ./a ./b')
  expect(fromRoot('serve --config=/work/conf.json', '/work')).toBe('serve --config=./conf.json')
  expect(fromRoot(`run "/work/my dir/x" '/work/y'`, '/work')).toBe(`run "./my dir/x" './y'`)
})

test('a look-alike folder, a path in the middle of a word and a path outside the root stay', () => {
  expect(fromRoot('/workshop/a.sh', '/work')).toBe('/workshop/a.sh')
  expect(fromRoot('echo x/work/a', '/work')).toBe('echo x/work/a')
  expect(fromRoot('/elsewhere/work/a.sh', '/work')).toBe('/elsewhere/work/a.sh')
  expect(fromRoot('sleep 5', '/work')).toBe('sleep 5')
})

test('the root alone is not a path under the root, so it stays', () => {
  expect(fromRoot('cd /work', '/work')).toBe('cd /work')
})

test('a root with a trailing slash or dots in it works; no root, or the folder root, change nothing', () => {
  expect(fromRoot('/work/a', '/work/')).toBe('./a')
  expect(fromRoot('/a.b/x', '/a.b')).toBe('./x')
  expect(fromRoot('/axb/x', '/a.b')).toBe('/axb/x') // the dot is not a wildcard
  expect(fromRoot('/work/a', undefined)).toBe('/work/a')
  expect(fromRoot('/work/a', '')).toBe('/work/a')
  expect(fromRoot('/work/a', '/')).toBe('/work/a')
})

// A drive-letter root is a Windows root: a name there may use backslashes, or either form in one command. The stored
// command does not change, only the view.
test('a Windows root shortens a path with backslashes, with slashes or with both, whichever way the root is spelled', () => {
  expect(fromRoot('C:\\work\\server.js', 'C:/work')).toBe('./server.js')
  expect(fromRoot('C:\\work\\a.js', 'C:\\work')).toBe('./a.js')
  expect(fromRoot('node C:/work/a.js C:\\work\\b.js', 'C:\\work')).toBe('node ./a.js ./b.js')
  expect(fromRoot('serve --config="C:\\work\\my dir\\c.json"', 'C:/work/')).toBe('serve --config="./my dir\\c.json"')
})

test('a Windows look-alike folder, the root alone and the drive root stay', () => {
  expect(fromRoot('C:\\workshop\\a.js', 'C:/work')).toBe('C:\\workshop\\a.js')
  expect(fromRoot('cd C:\\work', 'C:/work')).toBe('cd C:\\work')
  expect(fromRoot('C:\\x\\y.js', 'C:\\')).toBe('C:\\x\\y.js')
  expect(fromRoot('C:/x/y.js', 'C:/')).toBe('C:/x/y.js')
})

test('a backslash after a folder root is part of a name there: the separator is a slash only', () => {
  expect(fromRoot('/work\\a', '/work')).toBe('/work\\a')
})
