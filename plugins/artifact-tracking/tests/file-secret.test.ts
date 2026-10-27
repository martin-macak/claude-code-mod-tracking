// The secret rule of the file preview (issue #57, L2; owner decision Q2): the row of a secret file is tracked (a path only), but its
// preview shows a notice and never reads the file. A fixed rule, and the globs of `trackers.file.secretPaths`. Pure.
// Design study G3: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787
import { expect, test } from 'claude-code/testing'
import { isSecretPath } from '../trackers/file/secret'
import { expectLinear } from './fixtures/scaling'

const secret = (path: string, o: Parameters<typeof isSecretPath>[1] = {}) => isSecretPath(path, o)

test('.env and .env.<anything> are secret, but the example, sample and template files are not', () => {
  for (const p of ['/work/.env', '/work/.env.local', '/work/app/.env.production', '/work/.env.development.local'])
    expect(secret(p), p).toBe(true)
  for (const p of [
    '/work/.env.example',
    '/work/.env.sample',
    '/work/.env.template',
    '/work/env.ts',
    '/work/.environment',
  ])
    expect(secret(p), p).toBe(false)
})

test('keys and certificates are secret by their extension, and SSH keys by their name', () => {
  for (const p of [
    '/w/server.pem',
    '/w/tls/private.key',
    '/w/cert.p12',
    '/w/cert.pfx',
    '/w/vault.kdbx',
    '/w/id_rsa',
    '/w/id_rsa.pub',
    '/w/id_ed25519',
    '/w/id_ecdsa_sk',
  ])
    expect(secret(p), p).toBe(true)
  for (const p of ['/w/keyboard.ts', '/w/monkey.js', '/w/pem.md', '/w/id_dsa', '/w/key', '/w/a.key.ts'])
    expect(secret(p), p).toBe(false)
})

test('files that hold credentials by name are secret: .netrc, .pgpass, .pypirc and .npmrc', () => {
  for (const p of ['/home/u/.netrc', '/home/u/.pgpass', '/work/.pypirc', '/work/.npmrc'])
    expect(secret(p), p).toBe(true)
  expect(secret('/work/.npmrc.example')).toBe(false)
  expect(secret('/work/npmrc')).toBe(false)
})

test('everything below .ssh, .gnupg, .aws, .kube and .config/gh is secret, in any home, and .docker/config.json too', () => {
  for (const p of [
    '/home/u/.ssh/config',
    '/Users/u/.ssh/known_hosts',
    '/root/.gnupg/pubring.kbx',
    '/home/u/.aws/credentials',
    '/home/u/.kube/config',
    '/home/u/.config/gh/hosts.yml',
    '/home/u/.docker/config.json',
    '/work/deep/.ssh/anything.txt',
  ])
    expect(secret(p), p).toBe(true)
  for (const p of [
    '/home/u/.docker/daemon.json',
    '/home/u/.config/other/x',
    '/work/ssh/config',
    '/work/.sshx/a',
    '/home/u/.awsx/a',
  ])
    expect(secret(p), p).toBe(false)
})

test('the rule ignores case, and a Windows path with backslashes is read as a path', () => {
  expect(secret('/work/.ENV')).toBe(true)
  expect(secret('/work/Server.PEM')).toBe(true)
  expect(secret('/work/ID_RSA')).toBe(true)
  expect(secret('/home/u/.SSH/config')).toBe(true)
  expect(secret('C:\\Users\\u\\.ssh\\id_rsa')).toBe(true)
  expect(secret('C:\\work\\src\\a.ts')).toBe(false)
  expect(secret('/work/.Env.Example')).toBe(false)
})

test('an ordinary file is no secret, and neither is the empty path', () => {
  for (const p of ['/work/src/a.ts', '/work/README.md', '/work/package.json', '/work/.gitignore', ''])
    expect(secret(p), p).toBe(false)
})

test('a glob of secretPaths without a slash matches the file name, in any folder', () => {
  const extra = ['*.vault', 'token-?.txt']
  expect(secret('/work/a/b/prod.vault', { extra })).toBe(true)
  expect(secret('/work/token-1.txt', { extra })).toBe(true)
  expect(secret('/work/token-12.txt', { extra })).toBe(false)
  expect(secret('/work/prod.vault.md', { extra })).toBe(false)
  expect(secret('/work/prod.vault', {})).toBe(false)
})

test('a glob with a slash matches the path: absolute from the root, relative at any folder, ** across folders and * within one', () => {
  expect(secret('/srv/vault/a.txt', { extra: ['/srv/vault/*'] })).toBe(true)
  expect(secret('/srv/vault/deep/a.txt', { extra: ['/srv/vault/*'] })).toBe(false)
  expect(secret('/srv/vault/deep/a.txt', { extra: ['/srv/vault/**'] })).toBe(true)
  expect(secret('/work/proj/secrets/a.txt', { extra: ['secrets/*'] })).toBe(true)
  expect(secret('/work/mysecrets/a.txt', { extra: ['secrets/*'] })).toBe(false)
})

test('a double star that is a whole segment takes no folder as well as many: /srv/<stars>/key matches /srv/key (Q2, fail-open)', () => {
  const extra = ['/srv/**/key']
  for (const p of ['/srv/key', '/srv/a/key', '/srv/a/b/key', '/SRV/A/KEY']) expect(secret(p, { extra }), p).toBe(true)
  for (const p of ['/srv/keys', '/srv/a/mykey', '/srvx/key', '/other/srv/key', '/srv/key/x'])
    expect(secret(p, { extra }), p).toBe(false)
  // A relative glob finds the folder at any depth, and a leading one that takes no folder matches from the root of the path.
  expect(secret('/work/a/b/key', { extra: ['**/b/key'] })).toBe(true)
  expect(secret('b/key', { extra: ['**/b/key'] })).toBe(true)
  expect(secret('/work/a/xb/key', { extra: ['**/b/key'] })).toBe(false) // `b` is the whole folder name, not the end of one
  // Two of them in one glob, and a double star that is no whole segment keeps its meaning: any run, slashes too.
  expect(secret('/w/a/b', { extra: ['/w/**/**/b'] })).toBe(true)
  expect(secret('/w/xa/b', { extra: ['/w/a**/b'] })).toBe(false)
  expect(secret('/w/ax/y/b', { extra: ['/w/a**/b'] })).toBe(true)
})

test('? is one character but a slash, * stays in one folder, and a trailing double star takes the rest', () => {
  expect(secret('/w/k1/a', { extra: ['/w/k?/a'] })).toBe(true)
  expect(secret('/w/k//a', { extra: ['/w/k?/a'] })).toBe(false)
  expect(secret('/w/ka/b/c', { extra: ['/w/k*/c'] })).toBe(false)
  expect(secret('/w/ka/c', { extra: ['/w/k*/c'] })).toBe(true)
  expect(secret('/w/k/a/b/c', { extra: ['/w/k/**'] })).toBe(true)
})

test('the home folder in a ~/ glob is plain text: its wildcards and its trailing slash do not leak into the glob', () => {
  expect(secret('/h*me/u/keys/a', { extra: ['~/keys/*'], home: '/h*me/u/' })).toBe(true)
  expect(secret('/home/u/keys/a', { extra: ['~/keys/*'], home: '/h*me/u/' })).toBe(false)
})

test('a glob with many wildcards between literals costs time in proportion to the path, not a power of it', async () => {
  // A regular expression tries the ways to match one by one: five stars between literals take 0.1 s on this path, eight take 14 s.
  const extra = [`${'*a'.repeat(10)}b`, `/w/${'**/d'.repeat(8)}/nope`]
  expect(secret(`/w/${'a'.repeat(60)}c`, { extra })).toBe(false)
  expect(secret(`/w/${'a'.repeat(60)}b`, { extra })).toBe(true)
  await expectLinear({
    make: scale => `/w/${'a'.repeat(100 * scale)}c/${'d/'.repeat(20 * scale)}x`,
    run: path => secret(path, { extra }),
  })
})

test('a glob that starts with ~/ is read in the home folder, and does nothing when the home is not known', () => {
  const extra = ['~/keys/**']
  expect(secret('/home/u/keys/a/b.txt', { extra, home: '/home/u' })).toBe(true)
  expect(secret('/home/v/keys/a.txt', { extra, home: '/home/u' })).toBe(false)
  expect(secret('/home/u/keys/a.txt', { extra })).toBe(false)
  expect(secret('/home/u/keys/a.txt', { extra, home: '' })).toBe(false)
})

test('the characters of a regular expression in a glob are plain characters, and a long run of stars does not hang', () => {
  expect(secret('/w/a+b(1).txt', { extra: ['a+b(1).txt'] })).toBe(true)
  expect(secret('/w/aab.txt', { extra: ['a+b.txt'] })).toBe(false)
  expect(secret('/w/a[1].txt', { extra: ['a[1].txt'] })).toBe(true)
  expect(secret('/w/x.txt', { extra: [`${'*'.repeat(150)}y${'*'.repeat(40)}`] })).toBe(false)
  expect(secret('/work/CASE.vault', { extra: ['*.Vault'] })).toBe(true)
})
