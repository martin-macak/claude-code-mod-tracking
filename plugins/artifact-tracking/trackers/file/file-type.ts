// The type of a file (issue #57, R6 and R7): one of a fixed set of words. A fixed map of file names and extensions decides
// first. A name the map does not know gets one `file --mime-type` call, off the hook path; its answer is kept on the
// record and read here. With no answer the type is `other`. Pure: no `$`, no I/O.
// Design study: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787 (R6, R7).

/** The types, in the order the Files section sorts them. The type word is `facets.kind` of the row. */
export const FILE_TYPES = ['code', 'config', 'docs', 'data', 'markup', 'image', 'other'] as const
export type FileType = (typeof FILE_TYPES)[number]

/** Extensions, lower case, by type. The table is a choice: `json` is data, `yaml` is config (a name rule can override it). */
const EXTENSIONS: Readonly<Record<Exclude<FileType, 'other'>, string>> = {
  code: 'ts tsx mts cts js jsx mjs cjs py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish ps1 lua pl r scala clj ex exs erl hs ml sql dart vue svelte ipynb',
  config: 'yaml yml toml ini cfg conf properties lock editorconfig npmrc nvmrc tf tfvars hcl',
  docs: 'md mdx markdown rst txt adoc org tex pdf',
  data: 'json json5 jsonc csv tsv jsonl ndjson parquet sqlite db xlsx xls avro proto graphql gql',
  markup: 'html htm xml xhtml css scss sass less svg',
  image: 'png jpg jpeg gif webp bmp ico tiff avif heic',
}

const BY_EXTENSION: ReadonlyMap<string, FileType> = new Map(
  Object.entries(EXTENSIONS).flatMap(([type, list]) => list.split(' ').map(ext => [ext, type as FileType] as const)),
)

/** File names that decide the type, whatever the extension (the name wins over the extension). */
const NAMES: Readonly<Record<string, FileType>> = {
  Dockerfile: 'config',
  Containerfile: 'config',
  Makefile: 'code',
  Justfile: 'code',
  Rakefile: 'code',
  Gemfile: 'config',
  Procfile: 'config',
  CODEOWNERS: 'config',
  LICENSE: 'docs',
  README: 'docs',
  '.gitignore': 'config',
  '.gitattributes': 'config',
  'package.json': 'config',
  'package-lock.json': 'config',
  'composer.json': 'config',
  'deno.json': 'config',
  'biome.json': 'config',
  'yarn.lock': 'config',
}

/** Name shapes that decide the type: `.env.local`, `Dockerfile.dev`, `tsconfig*.json`, `*.config.*` (`vite.config.mts`), `.eslintrc`. */
const NAME_RULES: readonly (readonly [RegExp, FileType])[] = [
  [/^\.env(\..+)?$/, 'config'],
  [/^Dockerfile\..+$/, 'config'],
  [/^tsconfig.*\.json$/, 'config'],
  [/\.config\.\w+$/, 'config'],
  [/^\.[\w-]+rc(\.json)?$/, 'config'],
]

/** The last segment of a path, with either slash. */
const baseOf = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/**
 * The type that the fixed map gives a path, by its file name, then by its extension. undefined: the map does not know the
 * name, so the caller may ask `file --mime-type` once.
 */
export function typeOfName(path: string): FileType | undefined {
  const base = baseOf(path)
  if (base === '') return undefined
  if (Object.hasOwn(NAMES, base)) return NAMES[base]
  for (const [rule, type] of NAME_RULES) if (rule.test(base)) return type
  const dot = base.lastIndexOf('.')
  return dot < 0 ? undefined : BY_EXTENSION.get(base.slice(dot + 1).toLowerCase()) // a name with no dot has no extension
}

/** A MIME type, as `file --mime-type` writes it: `text/x-script.python`, `image/png`. */
const MIME = /^[a-z]+\/[\w.+-]+$/

/** What the record keeps when `file` answered with no MIME type (`cannot open ...`, an empty answer). */
export const UNKNOWN_MIME = 'unknown'

/**
 * The MIME type in the answer of `file -b --mime-type`: its first line when that is a MIME type, else `unknown`. A missing
 * file gives `cannot open ...` and exit 0, so the answer is read and not the exit code.
 */
export function mimeOf(answer: string): string {
  const lines = answer.trim().split('\n')
  return lines.length === 1 && MIME.test(lines[0]!.trim()) ? lines[0]!.trim() : UNKNOWN_MIME
}

/** The type that a MIME type gives. A plain text file and a binary give `other`: the content does not say what it is for. */
export function typeOfMime(mime: string): FileType {
  const m = mime.trim()
  if (!MIME.test(m)) return 'other'
  if (m.startsWith('image/')) return 'image'
  if (/^text\/x-[\w.+-]+$/.test(m) || m === 'application/javascript' || m === 'text/javascript') return 'code'
  if (m === 'application/json' || m === 'text/csv') return 'data'
  if (m === 'text/html' || m === 'text/xml' || m === 'application/xml') return 'markup'
  if (m === 'application/pdf' || m === 'text/markdown') return 'docs'
  return 'other'
}

/** The type of a record: the map by its path, else its cached MIME type, else `other`. Pure: it makes no call. */
export function fileTypeOf(rec: { readonly label: string; readonly mime?: string | undefined }): FileType {
  return typeOfName(rec.label) ?? (rec.mime === undefined ? 'other' : typeOfMime(rec.mime))
}
