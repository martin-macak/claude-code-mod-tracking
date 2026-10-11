# Release a mod

How to cut a versioned release of a mod: a git tag, a GitHub release, and a zip artifact. Pinned to Claude Code 2.1.295 (types) and 2.1.296 (CLI runs). Claims come from the public docs snapshot of 2026-10-09 unless marked *observed* or *inference*. For marketplaces, scopes and admin, see [share-and-admin.md](share-and-admin.md).

## What Claude Code gives you

Claude Code has no release command and no registry upload. A "release" is made of three parts:

| Part | What it does | Source |
| --- | --- | --- |
| `version` in `plugin.json` | Detects updates. Users get a new copy only when the computed version changes. | [loading:268-295](../sources/code-claude-com-2026-10-09/plugins/loading.md#L268) |
| Tag `<name>--v<version>` | Names a release in git. Dependency ranges of other plugins resolve against these tags. | [dependencies:134-166](../sources/code-claude-com-2026-10-09/plugins/dependencies.md#L134) |
| A `.zip` of the plugin folder | Loads for one session with `--plugin-dir <zip>` or `--plugin-url <url>`. A marketplace `archive` entry installs it. | [cli-reference:877-878](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L877), [marketplace-reference:260](../sources/code-claude-com-2026-10-09/plugins/marketplace-reference.md#L260) |

The docs say a tag is needed only when other plugins declare a version range on yours. ([publish:174-178](../sources/code-claude-com-2026-10-09/plugins/publish.md#L174)) A tag per release still gives a fixed point for a GitHub release and its assets. *(inference)*

## The version rules

- Version resolution, for every source type but `command`: manifest `version`, then marketplace-entry `version`, then a value from the source (12-char commit SHA for git sources and for a relative path in a git-hosted marketplace; 12-char SHA-256 for `archive`). ([loading:282-295](../sources/code-claude-com-2026-10-09/plugins/loading.md#L282))
- Choose one: bump `version` on each release, or omit it so users track commits. ([publish:43-44](../sources/code-claude-com-2026-10-09/plugins/publish.md#L43), [host-marketplace:184-195](../sources/code-claude-com-2026-10-09/plugins/host-marketplace.md#L184))
- Do not set `version` in both `plugin.json` and the marketplace entry. The manifest wins without a warning at load. `validate` reports `Entry declares version "<a>" but <path>/plugin.json says "<b>"`. ([host-marketplace:195](../sources/code-claude-com-2026-10-09/plugins/host-marketplace.md#L195))
- With a pinned `version` and a relative-path entry on the default branch, a **fresh** install copies the branch head under the last version string. Commits after the last bump reach new installs but not existing ones. *(inference from the resolution order)* To hold users on released code, use a `git-subdir` entry with `ref` set to a tag, or let users add `<owner>/<repo>#<tag>`. A relative-path entry has no `ref`. ([host-marketplace:197-203](../sources/code-claude-com-2026-10-09/plugins/host-marketplace.md#L197))
- For two release lines (stable, early access), host two marketplaces with different `name`s whose entries point at different refs. Claude Code has no channel concept. ([host-marketplace:218-246](../sources/code-claude-com-2026-10-09/plugins/host-marketplace.md#L218))

## `claude plugin tag`

```text
claude plugin tag [path] [--push] [--dry-run] [-f|--force] [-m <msg>] [--remote <name>]
```

- Creates an **annotated** tag `<name>--v<version>`. The message defaults to `<name> <version>`; `%s` in `-m` stands for the version. ([cli-reference:524-545](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L524))
- Finds the marketplace entry by walking up from `[path]` to a `.claude-plugin/marketplace.json` that lists the plugin.
- Checks before tagging: validates the plugin; `plugin.json` and the marketplace entry agree on the version; the working tree under the plugin folder is clean; the tag does not exist. `--force` skips the last two. ([dependencies:153-158](../sources/code-claude-com-2026-10-09/plugins/dependencies.md#L153), [cli-reference:560-564](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L560))
- If the push fails, the tag stays local and the command exits 1.
- In a session: `/plugin tag [path] [--push] [--dry-run] [--force]`. ([cli-reference:824](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L824))
- A plain `git tag <name>--v<version>` also works. Then you keep the versions in sync yourself. ([dependencies:166](../sources/code-claude-com-2026-10-09/plugins/dependencies.md#L166))

*Observed* (2.1.296, plugin under `plugins/artifact-tracking`, marketplace at the repo root):

```text
Plugin:  artifact-tracking
Version: 0.1.0 (from plugin.json)
Tag:     artifact-tracking--v0.1.0

✔ Dry run — would create tag artifact-tracking--v0.1.0 at HEAD in <repo>
  git -C <repo> tag -a artifact-tracking--v0.1.0 -m "artifact-tracking 0.1.0"
  git -C <repo> push origin refs/tags/artifact-tracking--v0.1.0
```

## The zip artifact

- `--plugin-dir` takes a folder or a `.zip`. `--plugin-url` fetches a `.zip` from a URL. Both extract into a session temp folder and load the plugin as `<name>@inline`. ([cli-reference:877-878](../sources/code-claude-com-2026-10-09/plugins/cli-reference.md#L877), [loading:184](../sources/code-claude-com-2026-10-09/plugins/loading.md#L184))
- The publish docs name the case: attach a `.zip` to a release and let people start with `--plugin-url`. ([publish:72](../sources/code-claude-com-2026-10-09/plugins/publish.md#L72))
- *Observed:* a zip with one top folder (`git archive --format=zip --prefix=<name>/ HEAD:<plugin dir>`) loads. `claude --plugin-dir <zip> plugin list` shows `artifact-tracking@inline`, `Version: 0.1.0`, `Status: ✔ loaded`. A zip without the top folder was not tried.
- *Observed:* `claude plugin validate <file>.zip` fails with `json: Invalid JSON syntax: JSON Parse error: Unexpected identifier "PK"`. Validate the folder, not the zip.
- A marketplace `archive` entry takes `url` and `sha256` (64 hex chars). With `sha256`, Claude Code refuses a changed download. Needs 2.1.224 or later. ([marketplace-reference:144,260-275](../sources/code-claude-com-2026-10-09/plugins/marketplace-reference.md#L260))
- Download limits for an `archive` zip: 256 MiB, 120 s, at most five `https://` redirects. Headers are dropped on a cross-origin redirect. ([host-marketplace:47-63](../sources/code-claude-com-2026-10-09/plugins/host-marketplace.md#L47)) A GitHub release asset URL redirects to another origin. So a private repo's asset cannot be fetched with a header. *(inference)*

## The pipeline in this repo

Tag-driven. A person bumps the version and pushes the tag; CI builds and publishes.

```mermaid
sequenceDiagram
    actor Dev
    participant PR as Pull request
    participant Main as main
    participant Make as make release
    participant GH as GitHub Actions (release.yml)
    participant Rel as GitHub release

    Dev->>PR: bump "version" in plugin.json
    PR->>Main: squash merge (test.yml green)
    Dev->>Make: run on clean main == origin/main
    Make->>Make: make test
    Make->>Main: claude plugin tag --push (artifact-tracking--v<version>)
    Main-->>GH: push of tag artifact-tracking--v*
    GH->>GH: tag == name--v<version>, commit on main
    GH->>GH: validate --strict (plugin, marketplace), make test
    GH->>GH: make dist (zip + SHA256SUMS)
    GH->>GH: actions/attest (build provenance)
    GH->>Rel: gh release create --verify-tag --generate-notes
```

| Piece | File |
| --- | --- |
| Marketplace `mod-tracking`, one relative-path entry | `.claude-plugin/marketplace.json` |
| `dist`, `release`, `release-dry` targets | `Makefile` |
| Release workflow | `.github/workflows/release.yml` |
| Steps for people | `plugins/artifact-tracking/README.md`, section "Release" |

Decisions:

- **Tag format** `<name>--v<version>`. It is the Claude Code convention, and it lets one repo hold several plugins.
- **Version** pinned in `plugin.json`, none in the marketplace entry. `plugin tag` and `validate` check that they agree.
- **The workflow re-checks the tag.** A hand-made tag skips the checks of `plugin tag`. The workflow fails when the tag does not equal `<name>--v<version>` of the tagged `plugin.json`, or when the commit is not on `main`.
- **The zip is built by `git archive` from the tagged tree.** Ignored and untracked files never enter it. The zip holds the same files a marketplace install copies. *(inference)*
- **Release notes** come from GitHub's generator, which lists the merged PRs. PR titles are Conventional Commits, so the notes read as a changelog. The start point is the previous tag of the same plugin.
- **Provenance:** `actions/attest@v4` signs the zip. It needs `id-token: write`, `attestations: write` and `artifact-metadata: write`. Check with `gh attestation verify <zip> --repo <owner>/<repo>`. Public repos only on Free, Pro and Team plans (actions/attest README).

## See also

- [share-and-admin.md](share-and-admin.md): marketplaces, the install line, scopes, auto-update
- [validate-test-debug.md](validate-test-debug.md): `validate --strict` and `plugin test`
- [../open-questions.md](../open-questions.md): items 20 and 21
