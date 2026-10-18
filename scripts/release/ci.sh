#!/usr/bin/env bash
# Release workflow operations also run in the shell regression suite.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=scripts/release/version.sh
source "$here/version.sh"

milestone() {
  local pages
  pages=$(gh api --paginate 'repos/{owner}/{repo}/milestones?state=all&per_page=100') || return 1
  jq -cs --arg title "artifact-tracking $1" 'add | .[] | select(.title == $title)' <<< "$pages"
}

case "${1:-}" in
  check-tag)
    version=$(tag_version "${2:-}")
    git merge-base --is-ancestor HEAD origin/main || { echo 'Release commit is not on main.' >&2; exit 1; }
    echo "$version" ;;
  stamp)
    version=$(tag_version "${2:-}")
    manifest=plugins/artifact-tracking/.claude-plugin/plugin.json
    jq --arg version "$version" '.version = $version' "$manifest" > "$manifest.tmp"
    mv "$manifest.tmp" "$manifest" ;;
  milestone) milestone "$2" ;;
  close-milestone)
    valid_version "$2" || exit 1
    release_version=${2%%+*}
    if [[ "$release_version" != *-* ]]; then
      item=$(milestone "$2")
      if [ -n "$item" ]; then
        number=$(jq -r .number <<< "$item")
        gh api "repos/{owner}/{repo}/milestones/$number" --method PATCH -f state=closed
      fi
    fi ;;
  activate-marketplace)
    repo=${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
    release=$(gh api "repos/$repo/releases/latest")
    tag_version "$(jq -r .tag_name <<< "$release")" >/dev/null
    jq -e '.prerelease == false and any(.assets[]; .name == "artifact-tracking.zip" and .state == "uploaded")' <<< "$release" >/dev/null || {
      echo 'Refusing cutover: latest stable release needs artifact-tracking.zip.' >&2; exit 1;
    }
    catalog=.claude-plugin/marketplace.json
    jq --arg url "https://github.com/$repo/releases/latest/download/artifact-tracking.zip" \
      '(.plugins[] | select(.name == "artifact-tracking") | .source) = {source: "archive", url: $url}' \
      "$catalog" > "$catalog.tmp"
    mv "$catalog.tmp" "$catalog"
    echo 'Marketplace entry changed. Validate it and submit the cutover in a PR.' ;;
  publish)
    tag=$2
    version=$(tag_version "$tag")
    extra=()
    if [[ "${version%%+*}" == *-* ]]; then extra+=(--prerelease --latest=false)
    else extra+=(--latest); fi
    prev=$(git describe --tags --abbrev=0 --match 'artifact-tracking--v*' "${tag}^" 2>/dev/null || true)
    if [ -n "$prev" ]; then extra+=(--notes-start-tag "$prev"); fi
    zip="artifact-tracking-$version.zip"
    cat > "$RUNNER_TEMP/notes.md" <<EOF
## Install

From this release, for one session:

\`\`\`sh
claude --plugin-url https://github.com/${REPO}/releases/download/${tag}/${zip}
\`\`\`

Stable marketplace: \`claude plugin install artifact-tracking --marketplace ${REPO}\`.
Update: \`claude plugin update artifact-tracking@mod-tracking\`.
Pre-releases do not change the stable marketplace.

Verify: \`sha256sum -c SHA256SUMS\` and \`gh attestation verify ${zip} --repo ${REPO}\`.
Tested with Claude Code ${CLAUDE_CODE_VERSION}.
EOF
    gh release create "$tag" "dist/$zip" dist/artifact-tracking.zip dist/SHA256SUMS \
      --verify-tag --title "artifact-tracking $version" \
      --notes-file "$RUNNER_TEMP/notes.md" --generate-notes "${extra[@]}" ;;
  *) echo 'Unknown release operation.' >&2; exit 1 ;;
esac
