// Masking of secrets in the text of a question (issue #71). The records keep every word. A text that goes to the screen or
// out of the mod (the pane, `/track qa`, the copy key) passes through `maskSecrets` first, unless the config turns masking
// off. A pattern is a known shape of a secret, never a guess: a text that only looks long and random stays. The list is in
// the README; scripts/contracts/questions-readme.test.mjs checks that each `label` is there. Pure.

/** What a masked secret becomes. */
export const MASKED = '[masked]'

type Rule = {
  readonly id: string
  /** The name the README lists. */
  readonly label: string
  readonly pattern: RegExp
  /** What the match becomes. Default: `MASKED`. `$1` keeps a group, so a name or a prefix stays. */
  readonly replace?: string
}

// Every quantifier before the value is bounded. The value runs to its end, however long: a cap would leave the tail of a long
// credential as it was. It is the last part of a pattern and runs over a class that does not repeat across the match, so a long
// text still costs a linear scan (the tests check it). A quoted value reads a backslash and the character after it as one unit,
// so an escaped quote does not close it. The two branches of that group cannot match the same character: no backtracking blow-up.
// A value in double quotes may span lines (a JSON string, a shell value), up to about 4 KB, so a scan that finds no closing quote
// is bounded. A longer value, or a quote that never closes, reads as an unquoted value: to the first space. A value in single
// quotes stays on its line, so an apostrophe in prose (`the token: 'tis fine`) cannot mask the lines after it (owner decision of
// 2026-10-22).
const DOUBLE_QUOTED_MAX = 4096
const NAME = String.raw`[\w-]{0,40}`
const SECRET_NAMES = '(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)'

export const SECRET_PATTERNS: readonly Rule[] = [
  {
    id: 'github-token',
    label: 'GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  },
  {
    id: 'github-fine-grained-token',
    label: 'GitHub fine-grained token (`github_pat_`)',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  },
  { id: 'gitlab-token', label: 'GitLab token (`glpat-`)', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'npm-token', label: 'npm token (`npm_`)', pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { id: 'anthropic-or-openai-key', label: 'Anthropic or OpenAI key (`sk-`)', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  {
    id: 'stripe-key',
    label: 'Stripe key (`sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`)',
    pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  { id: 'aws-access-key-id', label: 'AWS access key id (`AKIA`, `ASIA`)', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    id: 'slack-token',
    label: 'Slack token (`xoxa-`, `xoxb-`, `xoxe-`, `xoxp-`, `xoxr-`, `xoxs-`)',
    pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  },
  { id: 'google-api-key', label: 'Google API key (`AIza`)', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    id: 'jwt',
    label: 'JSON Web Token (three parts that start with `eyJ`)',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'private-key',
    label: 'private key block (`-----BEGIN ... PRIVATE KEY-----`, to the end line or the end of the text)',
    pattern: /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
  },
  {
    id: 'bearer-token',
    label: 'bearer token (`Bearer <value>`)',
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
    replace: `$1${MASKED}`,
  },
  {
    id: 'url-password',
    label: 'password in a URL (`scheme://user:password@host`)',
    pattern: /(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,100}:)[^\s@/]+(@)/gi,
    replace: `$1${MASKED}$2`,
  },
  {
    id: 'assignment',
    label:
      'value after a name that holds `password`, `passwd`, `pwd`, `passphrase`, `secret`, `token`, `api_key`, `access_key` or `private_key`',
    pattern: new RegExp(
      String.raw`(\b${NAME}${SECRET_NAMES}${NAME}["']?\s{0,4}[:=]\s{0,4})("(?:[^"\\]|\\[\s\S]){0,${DOUBLE_QUOTED_MAX}}"|'(?:[^'\\\n]|\\.)*'|[^\s,;]+)`,
      'gi',
    ),
    replace: `$1${MASKED}`,
  },
]

/** `text` with every known secret replaced by `[masked]`. Masking twice gives what masking once gives. */
export function maskSecrets(text: string): string {
  let out = text
  for (const { pattern, replace } of SECRET_PATTERNS) out = out.replace(pattern, replace ?? MASKED)
  return out
}

/** The spans `[start, end)` of every known secret in `text`, in no order. Patterns may overlap. The byte cut reads them. */
export function secretSpans(text: string): [number, number][] {
  return SECRET_PATTERNS.flatMap(({ pattern }) =>
    [...text.matchAll(pattern)].map((m): [number, number] => [m.index ?? 0, (m.index ?? 0) + m[0].length]),
  )
}

// The words that ask for a secret, as the assignment pattern names them: `passwd` and `pwd` count like `password`.
const SENSITIVE =
  /pass(?:word|phrase|code|wd)|\bpwd\b|secret|token|api[ _-]?key|credential|private[ _-]?key|auth[ _-]?key/i

/**
 * True when a question or its header asks for a secret. The typed answer and the notes of such a question are masked
 * whole, because a password has no shape that a pattern could know.
 */
export function isSensitive(...texts: readonly string[]): boolean {
  return texts.some(t => SENSITIVE.test(t))
}

/** The words of a question that can say it asks for a secret: the question, its header, its helper text and the placeholder of its text box. */
export type QuestionWords = {
  readonly question: string
  readonly header: string
  readonly description?: string
  readonly placeholder?: string
}

/** True when the words of a question ask for a secret (`isSensitive` over all of them). The pane, the exports and the byte cut share it. */
export const wordsAskForSecret = (q: QuestionWords): boolean =>
  isSensitive(q.question, q.header, q.description ?? '', q.placeholder ?? '')
