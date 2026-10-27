# File signals as a hook sees them (issue #57)

Date: 2026-10-27. Engine: Claude Code 2.1.310 for the probes (the types snapshot is 2.1.302).

This page records what a `tool.call` hook sees when Claude reads, writes, edits, creates or removes a file, and which of those facts the artifact-tracking mod keeps. The probes belong to the design study of [issue #57](https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787). P1 was a headless `claude -p` run with a fake Messages API and a probe mod that logged each `tool.call` input and the answer of `next(e)`. P4 ran `file` and `git` in a shell. The scrubbed shapes are in the [evidence comment](https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414685528). The user-facing description of the Files section is in the [README, Files](../../../../plugins/artifact-tracking/README.md#files).

## Grades

| Tag | Meaning | KB grade |
| --- | --- | --- |
| `[observed]` | Seen in a probe run with a fake API behind the engine (no model, no account) | *verified-kit* (a headless run is never *verified-live*) |
| `[primary source]` | Stated by the types file or by the public docs snapshot | *types-only* |
| `[inference]` | Nobody ran it | *inference* |

## What the hook sees of a file tool

The hook gets `e` with the tool input at the top level (`e.file_path`, `e.notebook_path`, `e.command`). `next(e)` answers `{ ref, result, text }`, with `isError: true` on a failure and `isReadOnly: true` when the engine held the input read-only. The mod counts a call only when it succeeded: an `isError` answer, a `{ deny }` and a result with `staged: true` add nothing.

| Tool | Result | Where the path is | Tag |
| --- | --- | --- | --- |
| `Read` of text | `{ type: 'text', file: { filePath, content, numLines, startLine, totalLines } }` | `result.file.filePath` | `[observed]` P1 |
| `Read` of the same file, unchanged | `{ type: 'file_unchanged', file: { filePath } }` ([d.ts:21818](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21818)) | `result.file.filePath` | `[observed]` P1 |
| `Read` of a notebook, a PDF, parts of a PDF | `type` is `notebook`, `pdf` or `parts` ([d.ts:21775](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21775)) | `result.file.filePath` | `[observed]` P1 (`notebook`, `pdf`), `[primary source]` (`parts`) |
| `Read` of an image | `{ type: 'image', file: { base64, type, originalSize, dimensions } }` ([d.ts:21754](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21754)) | None in the result. Use `input.file_path`. | `[observed]` P1 |
| `Read` of a binary file or a missing file | `isError: true`, the result is a string (`Error: …`) | None | `[observed]` P1 |
| `Write` | `{ type: 'create' \| 'update', filePath, content, structuredPatch, originalFile, userModified }` ([d.ts:22224](../sources/claude-code-2.1.302/types/claude-code.d.ts#L22224)) | `result.filePath` | `[observed]` P1 |
| `Edit` | `{ filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll }` | `result.filePath` | `[observed]` P1 |
| `NotebookEdit` | Success has `error: ""` and `notebook_path`. Failure is a string with `isError: true`. | `result.notebook_path` | `[observed]` P1 |
| Any edit tool | `staged: true`: the edit was held for the machine owner to review, and the file is unchanged ([d.ts:21346](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21346)) | n/a | `[primary source]` |

`Grep` and `Glob` name no file that Claude opened, so the mod ignores them.

## Bash and `bashEditDiff`

A Bash result may hold `bashEditDiff`. The field says which files the command changed in the git work tree. It is marked `@internal` in the types ([d.ts:21204](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21204)) and "in public beta" in the docs, so the mod reads it with guards and treats an odd shape as no field.

| Part | Meaning | Tag |
| --- | --- | --- |
| `files[]` | The files with a diff: `filePath`, `hunks`, and `created: true` or `deleted: true`. A file with neither flag was modified. | `[observed]` P1: `sed -i`, `>`, `>>`, `tee`, `cp` + `mv`, `touch`, `rm` of a tracked and of an untracked file |
| `moreFiles` | How many changed files `files[]` does not show | `[primary source]` |
| `changedFiles` | Absolute paths of every changed file known, shown or not, at most 200 | `[primary source]` ([hooks.md:1655](../sources/code-claude-com-2026-10-09/hooks/hooks.md#L1655)) |
| `unavailable`, `skipped`, `shared` | The list may be incomplete (`skipped`: `git checkout`, `git stash`) or may hold a change of a concurrent command | `[primary source]` |

- **The flags cover few files.** Only the files of `files[]` carry `created` or `deleted`, and `files[]` holds the diffs of up to 5 changed files ([hooks.md:1656](../sources/code-claude-com-2026-10-09/hooks/hooks.md#L1656)). `[primary source]`. No probe checked the limit of 5. A path of `changedFiles` that `files[]` does not show has no flag, so the mod records it as edited, also when the command removed it. `[inference]`: this consequence.
- **When Claude Code records it.** In auto mode and `bypassPermissions` mode, and only when Claude Code directs Claude to edit files through Bash. In every mode when the setting `bashEditDiffEnabled` turns it on. `bashEditDiffEnabled: false` turns it off ([hooks.md:1643](../sources/code-claude-com-2026-10-09/hooks/hooks.md#L1643)). `[primary source]`. P1 ran in `bypassPermissions` mode only.
- **What it leaves out.** Files that Git ignores and files in submodules ([hooks.md:1645](../sources/code-claude-com-2026-10-09/hooks/hooks.md#L1645)). A write outside the work tree has no field (`[observed]` P1). A background command and a read-only command carry no diff. A read-only command has `isReadOnly: true` (`[observed]` P1: `cat notes.md | head -2; tail -1 src/a.ts`).
- **A failed command.** The field says what changed on disk, so the mod counts the files of a call with `isError: true` too.

## The type of a file: `file -b --mime-type`

The mod types a file by a fixed map of names and extensions. A name the map does not know gets one `file -b --mime-type -- <path>` call in the background, after the hook has returned. P4 ran it in a shell, not through the tool of the mod in a live session.

| Fact | Tag |
| --- | --- |
| It answers `text/x-script.python`, `text/plain`, `image/svg+xml`, `application/json` or `application/octet-stream`. A call takes about 5 ms. | `[observed]` P4 |
| A missing file answers `cannot open …` with **exit 0**, so the mod reads the answer and not the exit code. A word that is no MIME type is kept as `unknown`. | `[observed]` P4 |
| A Linux image with no `file` answers exit 127. The mod leaves the type `other`. | `[observed]` P4 |
| `image/*` is `image`, `text/x-*` and JavaScript are `code`, JSON and CSV are `data`, HTML and XML are `markup`, PDF and Markdown are `docs`, the rest is `other`. | the mod's rule |

## What the mod keeps

Each file is a row of the Files section, keyed by where the file landed. The row has one of seven types: `code`, `config`, `docs`, `data`, `markup`, `image` or `other`. The type word is in the type cell and in `facets.kind`.

| Config key | Default | Effect |
| --- | --- | --- |
| `trackers.file.scope` | `all` | `md` keeps `.md` files only, as before issue #57 |
| `trackers.file.maxMentionsPerRow` | 20 | Paths read from one prompt or reply, one stat each |
| `trackers.file.maxFiles` | 300 | The most file rows. The shared cap `global.store.maxItems` still applies, and the lower of the two wins |
| `trackers.file.bashEdits` | `true` | Count the files that `bashEditDiff` names |
| `trackers.file.mime` | `true` | Ask `file --mime-type` for a name the map does not know |

When a cap drops rows, `ItemKind.capRank` decides: a file that was only read ranks 0, a file that was only named ranks 1, a file that was written ranks 2. The lowest rank goes first, then the oldest. `ItemKind.capOf` gives a kind a limit of its own (`maxFiles`). The record that a call has just added always stays.

## Not tested

- `bashEditDiff` in the default permission mode, with and without `bashEditDiffEnabled`.
- `bashEditDiff` after a cold resume with no stored copy: the replay reads the field from the stored tool result, and nobody checked that a transcript keeps it.
- A subagent's Bash call with an `agentId`.
- `file` on a Linux host that has it, and `file` through the tool of the mod in a live session.
- The rate of false positives for mentions of paths that are not Markdown.
