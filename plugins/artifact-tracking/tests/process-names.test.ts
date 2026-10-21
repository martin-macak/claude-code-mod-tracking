// The display name of a process row (issue #49, PR 2): a word of the command that starts with the session root shows from
// `./`. Issue #145: a word that starts with the home folder shows from `~/`. The stored name and the fingerprint stay as
// they are. Pure.
import { expect, test } from 'claude-code/testing'
import { displayName, fromHome, fromRoot } from '../trackers/processes/names'

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

// ---------------------------------------------------------------- the home folder (issue #145)

test('a path under the home folder shows from ~/', () => {
  expect(fromHome('/Users/me/projects/app/node_modules/.bin/vite', '/Users/me')).toBe(
    '~/projects/app/node_modules/.bin/vite',
  )
  expect(fromHome('node /Users/me/server.js --port 3000', '/Users/me')).toBe('node ~/server.js --port 3000')
})

test('every word that starts with the home folder is shortened, in a flag value and in quotes too', () => {
  expect(fromHome('cp /Users/me/a /Users/me/b', '/Users/me')).toBe('cp ~/a ~/b')
  expect(fromHome('serve --config=/Users/me/conf.json', '/Users/me')).toBe('serve --config=~/conf.json')
  expect(fromHome(`run "/Users/me/my dir/x" '/Users/me/y'`, '/Users/me')).toBe(`run "~/my dir/x" '~/y'`)
  expect(fromHome('/Users/me/a', '/Users/me/')).toBe('~/a') // a trailing slash of the home does not matter
})

test('a folder that only starts like the home folder is not shortened: /Users/me is a prefix of /Users/meg', () => {
  expect(fromHome('/Users/meg/a.sh', '/Users/me')).toBe('/Users/meg/a.sh')
  expect(fromHome('/Users/me.old/a.sh', '/Users/me')).toBe('/Users/me.old/a.sh')
  expect(fromHome('echo x/Users/me/a', '/Users/me')).toBe('echo x/Users/me/a') // not at the start of a word
  expect(fromHome('/elsewhere/Users/me/a.sh', '/Users/me')).toBe('/elsewhere/Users/me/a.sh')
  expect(fromHome('/Users/a.b/x', '/Users/a.b')).toBe('~/x')
  expect(fromHome('/Users/axb/x', '/Users/a.b')).toBe('/Users/axb/x') // the dot is not a wildcard
})

test('the home folder alone, no home and a folder home change nothing', () => {
  expect(fromHome('cd /Users/me', '/Users/me')).toBe('cd /Users/me')
  expect(fromHome('/Users/me/a', undefined)).toBe('/Users/me/a')
  expect(fromHome('/Users/me/a', '')).toBe('/Users/me/a')
  expect(fromHome('/Users/me/a', '/')).toBe('/Users/me/a')
  expect(fromHome('sleep 5', '/Users/me')).toBe('sleep 5')
})

test('a Windows home shortens a path with backslashes or with slashes', () => {
  expect(fromHome('C:\\Users\\me\\a.js', 'C:/Users/me')).toBe('~/a.js')
  expect(fromHome('node C:/Users/me/a.js C:\\Users\\me\\b.js', 'C:\\Users\\me')).toBe('node ~/a.js ~/b.js')
  expect(fromHome('C:\\Users\\meg\\a.js', 'C:/Users/me')).toBe('C:\\Users\\meg\\a.js')
  expect(fromHome('C:/x/y.js', 'C:/')).toBe('C:/x/y.js')
})

// Codex review of PR #180: `readView` accepts a UNC home (`\\host\share\me`) as absolute, so the name must shorten under it.
test('a UNC home shortens a path with backslashes or with slashes; a look-alike share folder stays', () => {
  expect(fromHome('\\\\host\\share\\me\\bin\\tool.exe', '\\\\host\\share\\me')).toBe('~/bin\\tool.exe') // as for C:, only the prefix changes
  expect(fromHome('node //host/share/me/a.js \\\\host\\share\\me\\b.js', '\\\\host\\share\\me')).toBe(
    'node ~/a.js ~/b.js',
  )
  expect(fromHome('\\\\host\\share\\me\\a.js', '//host/share/me')).toBe('~/a.js')
  expect(fromHome('\\\\host\\share\\meg\\a.js', '\\\\host\\share\\me')).toBe('\\\\host\\share\\meg\\a.js')
  expect(fromHome('\\\\other\\share\\me\\a.js', '\\\\host\\share\\me')).toBe('\\\\other\\share\\me\\a.js')
  expect(fromHome('\\\\host\\share\\me', '\\\\host\\share\\me')).toBe('\\\\host\\share\\me') // the home alone stays
  expect(fromHome('/host/share/me/a.js', '\\\\host\\share\\me')).toBe('/host/share/me/a.js') // a one-slash path is no UNC path
  expect(fromRoot('\\\\host\\work\\a.js', '\\\\host\\work')).toBe('./a.js') // the same rule serves the root
})

// A project usually sits under the home folder. The root goes first, so its `./` form wins.
test('a word under the root keeps ./ when the root sits under the home folder; the rest of the home shows ~/', () => {
  const show = (name: string) => displayName(name, '/Users/me/proj', '/Users/me')
  expect(show('/Users/me/proj/x.sh')).toBe('./x.sh')
  expect(show('cp /Users/me/proj/x.sh /Users/me/notes/y.txt')).toBe('cp ./x.sh ~/notes/y.txt')
  expect(show('/Users/me/proj-b/x.sh')).toBe('~/proj-b/x.sh') // a look-alike of the root is only under the home
  expect(show('/Users/me/proj')).toBe('~/proj') // the root alone is no path under it, but it is under the home folder
  expect(displayName('/Users/me/x', '/Users/me', '/Users/me')).toBe('./x') // the root is the home: the root wins
})

// R3 holds for every root, whatever the home: the root form wins for a word under the root. With the root above the home
// folder the home is the narrower folder, and the root form still wins. A change of that is a change of R3.
test('a word under the root keeps ./ also when the root is above the home folder', () => {
  expect(displayName('/Users/me/a.js', '/Users', '/Users/me')).toBe('./me/a.js')
  expect(displayName('cat /Users/me/a.js /opt/b.js', '/Users', '/Users/me')).toBe('cat ./me/a.js /opt/b.js')
})

test('with no root, no home or neither, displayName shortens what it can', () => {
  expect(displayName('/Users/me/proj/x', undefined, '/Users/me')).toBe('~/proj/x')
  expect(displayName('/Users/me/proj/x', '/Users/me/proj', undefined)).toBe('./x')
  expect(displayName('/Users/me/proj/x', undefined, undefined)).toBe('/Users/me/proj/x')
})
