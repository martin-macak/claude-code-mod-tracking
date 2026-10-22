// The masking of secrets in the text of a question (issue #71): every pattern, the text it leaves alone, the rule of a
// question that asks for a secret, and the list in the README. Pure.
import { expect, test } from 'claude-code/testing'
import { isSensitive, MASKED, maskSecrets, SECRET_PATTERNS } from '../trackers/questions/secrets'
import { expectLinear } from './fixtures/scaling'

// A secret must not stand in this file as a real one: each sample is built from pieces.
const hex = (n: number) => 'a1b2c3d4e5'.repeat(Math.ceil(n / 10)).slice(0, n)
const SAMPLES: Record<string, { text: string; secret: string }> = {
  'github-token': { text: `use ghp_${hex(36)} now`, secret: `ghp_${hex(36)}` },
  'github-fine-grained-token': { text: `github_pat_${hex(30)}_${hex(20)}`, secret: `github_pat_${hex(30)}_${hex(20)}` },
  'gitlab-token': { text: `glpat-${hex(20)}`, secret: `glpat-${hex(20)}` },
  'npm-token': { text: `npm_${hex(36)}`, secret: `npm_${hex(36)}` },
  'anthropic-or-openai-key': { text: `key sk-ant-api03-${hex(40)} here`, secret: `sk-ant-api03-${hex(40)}` },
  'stripe-key': { text: `${'sk'}_live_${hex(24)}`, secret: `${'sk'}_live_${hex(24)}` },
  'aws-access-key-id': { text: 'id AKIAABCDEFGHIJKLMNOP end', secret: 'AKIAABCDEFGHIJKLMNOP' },
  'slack-token': { text: `xoxb-${hex(12)}-${hex(12)}`, secret: `xoxb-${hex(12)}-${hex(12)}` },
  'google-api-key': { text: `AIza${hex(35)}`, secret: `AIza${hex(35)}` },
  jwt: {
    text: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${hex(20)}`,
    secret: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${hex(20)}`,
  },
  'bearer-token': { text: `Authorization: Bearer ${hex(32)}`, secret: hex(32) },
}

test('every pattern of the list masks its sample, and each sample belongs to one pattern of the list', () => {
  expect(Object.keys(SAMPLES).sort()).toEqual(
    SECRET_PATTERNS.map(p => p.id)
      .filter(id => !['private-key', 'url-password', 'assignment'].includes(id))
      .sort(),
  )
  for (const [id, { text, secret }] of Object.entries(SAMPLES)) {
    const out = maskSecrets(text)
    expect(out, id).not.toContain(secret)
    expect(out, id).toContain(MASKED)
  }
})

test('the text around a secret stays', () => {
  expect(maskSecrets(`use ghp_${hex(36)} now`)).toBe(`use ${MASKED} now`)
  expect(maskSecrets('id AKIAABCDEFGHIJKLMNOP end')).toBe(`id ${MASKED} end`)
  expect(maskSecrets(`Authorization: Bearer ${hex(32)}`)).toBe(`Authorization: Bearer ${MASKED}`)
})

test('a private key block is masked whole, also when the end line is missing', () => {
  // The marker lines are built from pieces: a line of a real key in a file would trip the secret scan of the repo.
  const line = (edge: 'BEGIN' | 'END', kind: string) => `-----${edge} ${kind}${'PRIVATE'} KEY-----`
  const body = `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${hex(40)}`
  const whole = `before\n${line('BEGIN', 'RSA ')}\n${body}\n${line('END', 'RSA ')}\nafter`
  expect(maskSecrets(whole)).toBe(`before\n${MASKED}\nafter`)
  const cut = `${line('BEGIN', '')}\n${body}`
  expect(maskSecrets(cut)).toBe(MASKED)
})

test('a password in a URL is masked and the rest of the URL stays', () => {
  expect(maskSecrets('clone https://ada:hunter2@example.com/repo.git')).toBe(
    `clone https://ada:${MASKED}@example.com/repo.git`,
  )
  expect(maskSecrets('https://example.com/a@b')).toBe('https://example.com/a@b')
})

test('a value after password, token, secret or key names keeps its name and loses its value', () => {
  expect(maskSecrets('password: hunter2')).toBe(`password: ${MASKED}`)
  expect(maskSecrets('DB_PASSWORD=hunter2 and more')).toBe(`DB_PASSWORD=${MASKED} and more`)
  expect(maskSecrets('GITHUB_TOKEN = "abc def"')).toBe(`GITHUB_TOKEN = ${MASKED}`)
  expect(maskSecrets("api_key: 'x y z'")).toBe(`api_key: ${MASKED}`)
  expect(maskSecrets('"client_secret": "abc123"')).toBe(`"client_secret": ${MASKED}`)
  expect(maskSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG')).toBe(`AWS_SECRET_ACCESS_KEY=${MASKED}`)
})

test('a value is masked to its end, however long: no tail of a long credential stays', () => {
  const long = hex(3000)
  expect(maskSecrets(`PASSWORD=${long} and more`)).toBe(`PASSWORD=${MASKED} and more`)
  expect(maskSecrets(`token: ${long}`)).toBe(`token: ${MASKED}`)
  const spaced = `${'word '.repeat(400)}end`
  expect(maskSecrets(`api_key = "${spaced}" after`)).toBe(`api_key = ${MASKED} after`)
  expect(maskSecrets(`secret: '${spaced}'`)).toBe(`secret: ${MASKED}`)
  expect(maskSecrets(`clone https://ada:${long}@example.com/repo.git`)).toBe(
    `clone https://ada:${MASKED}@example.com/repo.git`,
  )
})

test('text that is no secret is left as it is', () => {
  for (const text of [
    'Use the main branch',
    'sk-short',
    'ghp_tooshort',
    'We pass the token count to the model',
    'the password policy is strict',
    'key: a plain value is not named like a secret',
    '',
  ])
    expect(maskSecrets(text), text).toBe(text)
})

test('masking twice gives what masking once gives', () => {
  const text = `password: hunter2, ghp_${hex(36)}, https://a:b@c.d/e`
  expect(maskSecrets(maskSecrets(text))).toBe(maskSecrets(text))
})

test('masking a long text with many boundaries is linear', async () => {
  await expectLinear({ make: k => 'a-'.repeat(20_000 * k) + 'password=x', run: t => void maskSecrets(t) })
  await expectLinear({ make: k => 'token '.repeat(20_000 * k), run: t => void maskSecrets(t) })
})

test('masking a long value, and a long text of unclosed quotes, is linear', async () => {
  await expectLinear({ make: k => `password=${'x'.repeat(50_000 * k)}`, run: t => void maskSecrets(t) })
  await expectLinear({ make: k => `secret="${'x '.repeat(25_000 * k)}`, run: t => void maskSecrets(t) })
  await expectLinear({ make: k => 'token="a '.repeat(10_000 * k), run: t => void maskSecrets(t) })
  await expectLinear({ make: k => `https://ada:${'p'.repeat(50_000 * k)}`, run: t => void maskSecrets(t) })
})

test('isSensitive: a question that asks for a password, a token, a key or a secret', () => {
  expect(isSensitive('What is the password?', 'Login')).toBe(true)
  expect(isSensitive('Which one?', 'API key')).toBe(true)
  expect(isSensitive('Paste the access token.', 'Auth')).toBe(true)
  expect(isSensitive('Enter the passphrase', '')).toBe(true)
  expect(isSensitive('Which credentials should we use?', 'Creds')).toBe(true)
  expect(isSensitive('Which storage should we use?', 'Storage')).toBe(false)
  expect(isSensitive('Where should the records live?', 'Storage')).toBe(false)
})
