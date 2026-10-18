#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=scripts/release/version.sh
source "$here/version.sh"

version=${1:-}
[ -n "$version" ] || { echo 'VERSION is required: make release VERSION=x.y.z' >&2; exit 1; }
valid_version "$version" || { echo "Invalid version: $version" >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo 'Refusing: release runs on main only.' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Refusing: the working tree has changes.' >&2; exit 1; }
git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo 'Refusing: HEAD is not origin/main.' >&2; exit 1; }
while IFS= read -r tag; do
  previous=$(tag_version "$tag") || exit 1
  [ "$(compare_versions "$version" "$previous")" = 1 ] || { echo "Refusing: $version is not newer than $previous." >&2; exit 1; }
done < <(git tag -l 'artifact-tracking--v*')

if [[ "${version%%+*}" != *-* ]]; then
  if command -v gh >/dev/null 2>&1; then
    milestone=$(bash "$here/ci.sh" milestone "$version")
    if [ -n "$milestone" ] && [ "$(jq -r .open_issues <<< "$milestone")" != 0 ]; then
      echo "Refusing: milestone artifact-tracking $version has open issues." >&2
      exit 1
    fi
  else
    echo 'gh is unavailable; skipping the milestone guard.' >&2
  fi
fi
tag="artifact-tracking--v$version"
if [ "${2:-}" = --dry-run ]; then echo "Would create and push $tag"; exit 0; fi
make test
git tag -a "$tag" -m "artifact-tracking $version"
git push origin "refs/tags/$tag"
