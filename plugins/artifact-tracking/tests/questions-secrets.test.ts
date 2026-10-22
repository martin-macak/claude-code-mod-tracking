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

test('a quoted value runs to its real closing quote: an escaped quote inside it does not end it', () => {
  expect(maskSecrets('password: "abc\\"tail-secret" after')).toBe(`password: ${MASKED} after`)
  expect(maskSecrets("secret='abc\\'tail-secret' after")).toBe(`secret=${MASKED} after`)
  expect(maskSecrets('{"api_key": "a\\\\\\"b c", "x": 1}')).toBe(`{"api_key": ${MASKED}, "x": 1}`)
  // A value that ends in an escaped backslash is closed by the quote after it.
  expect(maskSecrets('token="abc\\\\" and more')).toBe(`token=${MASKED} and more`)
})

// Owner decision of 2026-10-22: a value in double quotes may span lines (a JSON string, a shell value) up to 4 KB, and a value
// in single quotes stays on its line, so an apostrophe in prose cannot mask the text after it.
test('a double-quoted value may span lines: it is masked to its closing quote', () => {
  expect(maskSecrets('password: "first line\nsecond line" after')).toBe(`password: ${MASKED} after`)
  expect(maskSecrets('secret: "one\ntwo\nthree"\nnext line')).toBe(`secret: ${MASKED}\nnext line`)
  // An escaped quote and an escaped newline are part of the value, across lines too.
  expect(maskSecrets('token="a\\"\nb\\\nc" tail')).toBe(`token=${MASKED} tail`)
})

test('a value in single quotes stays on its line, and a prose apostrophe masks nothing past it', () => {
  expect(maskSecrets("secret='one\ntwo' after")).toBe(`secret=${MASKED}\ntwo' after`)
  const prose = "the token: 'tis fine\nand the next line has a 'quote' in it"
  const out = maskSecrets(prose)
  expect(out).toBe(`the token: ${MASKED} fine\nand the next line has a 'quote' in it`)
  expect(maskSecrets("token: 'closed on its line' after")).toBe(`token: ${MASKED} after`)
})

test('a double-quoted value is read up to about 4 KB: a longer one reads as an unquoted value, a shorter one is masked whole', () => {
  const within = `${'x '.repeat(1900)}end` // 3.8 KB
  expect(maskSecrets(`password: "${within}" after`)).toBe(`password: ${MASKED} after`)
  const beyond = `${'x '.repeat(6000)}end` // 12 KB: no closing quote within the cap
  const out = maskSecrets(`password: "${beyond}" after`)
  expect(out.startsWith(`password: ${MASKED} `)).toBe(true) // the unquoted value ends at the first space
  expect(out.endsWith('" after')).toBe(true)
  expect(out.length).toBeGreaterThan(12_000) // the rest of the text is not swallowed
})

test('a double quote that never closes does not mask the rest of the text: it reads as an unquoted value', () => {
  expect(maskSecrets('password: "abc and the rest\nof the text')).toBe(`password: ${MASKED} and the rest\nof the text`)
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
  await expectLinear({ make: k => `token="${'a\\"'.repeat(25_000 * k)}`, run: t => void maskSecrets(t) })
  // A double quote that never closes reads on across lines up to the cap, and many of them cost the same each.
  await expectLinear({ make: k => `token="${'x\n'.repeat(50_000 * k)}`, run: t => void maskSecrets(t) })
  await expectLinear({ make: k => 'token="a\nb '.repeat(10_000 * k), run: t => void maskSecrets(t) })
  await expectLinear({ make: k => `token: '${'it\n'.repeat(50_000 * k)}`, run: t => void maskSecrets(t) })
  await expectLinear({ make: k => `token='${'\\\\'.repeat(25_000 * k)}`, run: t => void maskSecrets(t) })
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
