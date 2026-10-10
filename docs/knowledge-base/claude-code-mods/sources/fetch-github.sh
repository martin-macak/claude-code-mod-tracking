#!/usr/bin/env bash
# Fetch the public mod sources from GitHub into a local, gitignored cache.
# Usage: ./fetch-github.sh [claude-code-sha] [playground-sha]
# Pinned SHAs are the ones the KB was written against (2026-10-09).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/github-cache"
cc_sha="${1:-e47cc82bdbd27b5f799acd5b05fd0c29d33bb48c}"
pg_sha="${2:-569c5283d9a0a7ee7938df85bb32e4f48cbb8c86}"
rm -rf "$out" && mkdir -p "$out"
fetch() { # repo sha path dest
  local tmp; tmp="$(mktemp -d)"
  git -C "$tmp" init -q
  git -C "$tmp" remote add origin "https://github.com/$1.git"
  git -C "$tmp" sparse-checkout set "$3"
  git -C "$tmp" fetch -q --depth 1 --filter=blob:none origin "$2"
  git -C "$tmp" checkout -q FETCH_HEAD
  mkdir -p "$out/$4" && cp -R "$tmp/$3/." "$out/$4/"
  rm -rf "$tmp"
}
fetch anthropics/claude-code "$cc_sha" mods anthropics-claude-code/mods
fetch anthropics/claude-code-playground "$pg_sha" claude-code/mods anthropics-claude-code-playground/mods
echo "Fetched into $out"
