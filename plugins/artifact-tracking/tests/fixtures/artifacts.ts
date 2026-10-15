// Artifact tool fixtures, as the design study on issue #29 observed them at the hook (§3 "Observed shapes").
// Trimmed: fewer fields, and the scratch path shortened to `/tmp/work`.

/** The tool's URL id and the `artifact_id` of the same publish. */
export const PAIRS = [
  ['BonxpzeoKWbU2yQqP24wVg', '5783ece9-da46-4561-bdbe-8934f28bdedf'],
  ['QPLhKM631Kj8Y9Bq5njQNr', 'bd60b08d-adfc-494f-ad24-c6b136354f0f'],
  ['6nVdjCfqKZ6qBqqu7EGhsv', '2ed7cf0e-05fc-401d-ba58-e0a4e4194611'],
  ['HGbjxkPEveL2nVseu7wan9', '83bfc8ea-d074-415e-b973-f3dd4941a16e'],
] as const

export const PAGE_ID = PAIRS[0][0]
export const PAGE_UUID = PAIRS[0][1]
export const PAGE_URL = `https://claude.ai/artifact/${PAGE_ID}`
/** The same artifact in the form the claude.ai/code app links. */
export const PAGE_CODE_URL = `https://claude.ai/code/artifact/${PAGE_UUID}`
export const PAGE_KEY = `art:${PAGE_UUID}`
export const DOC_URL = 'https://claude.ai/artifact/D3zR4h4m4W1diV3brT2Mbo'

/** I:7: a first publish. `result.title` is the page `<title>`. */
export const PUBLISH = {
  input: { file_path: '/tmp/work/p29.html', icon: 'code', description: 'probe 29' },
  result: {
    artifact_id: PAGE_UUID,
    url: PAGE_URL,
    title: 'Probe Page 29',
    path: '/tmp/work/p29.html',
    version: '1791922596-a638',
    updated: false,
  },
}

/** I:15: a republish to the same URL. */
export const REPUBLISH = {
  input: { file_path: '/tmp/work/p29.html', url: PAGE_URL, label: 'probe republish' },
  result: {
    artifact_id: PAGE_UUID,
    url: PAGE_URL,
    title: 'Probe Page 29',
    path: '/tmp/work/p29.html',
    version: '1791922601-5d69',
    updated: true,
  },
}

/** I:30: an asset upload. The result has no title. */
export const ASSET = {
  input: { url: PAGE_URL, file_path: '/tmp/work/p29.txt', asset: true },
  result: {
    written: { url: PAGE_URL },
    asset_upload: {
      id: 'd52c2bcade7cfeb83a381c967884f148',
      url: '/_blob/d52c2bcade7cfeb83a381c967884f148',
      file_name: 'p29.txt',
    },
  },
}

/** I:38: an Artifact created from a type. No `artifact_id`. */
export const FROM_TYPE = {
  input: { type_url: 'https://claude.ai/artifact/TypeTypeTypeTypeType1', title: 'Probe Doc 29' },
  result: { created_from_type: true, url: DOC_URL, title: 'Probe Doc 29', version: '1791922622-e76c' },
}

/** I:42: a read. Its result names the artifact, but nothing was published. */
export const READ = {
  input: { action: 'read', url: PAGE_URL },
  result: { read: { url: PAGE_URL, code: 200, title: 'Probe Page 29' }, artifactRead: { slug: PAGE_UUID } },
}

/** I:66: a successful delete. */
export const DELETE = {
  input: { action: 'delete', url: PAGE_URL },
  result: { artifact_delete: { url: PAGE_URL, deleted: true } },
}

/** I:11: a failed publish: `isError` and a string. */
export const MISSING_FILE = {
  input: { file_path: '/tmp/work/missing-29.html' },
  result: 'Error: File not found: /tmp/work/missing-29.html.',
}

/** R:20: a refused publish to a page this session had not read. The error text holds the URL. */
export const REFUSED = {
  input: { url: PAGE_URL, file_path: '/tmp/work/o29.html' },
  result: `Error: You hadn't viewed the live version of ${PAGE_URL}, so the publish was refused.`,
}

/** R:28: the user answered No to a delete. */
export const DELETE_REJECTED = {
  input: { action: 'delete', url: PAGE_URL },
  result: "Error: The user doesn't want to proceed with this tool use.",
}
