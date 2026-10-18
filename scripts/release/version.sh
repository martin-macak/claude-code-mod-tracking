#!/usr/bin/env bash
# Compare SemVer without fixed-width arithmetic or GNU-only sort flags.
set -euo pipefail
export LC_ALL=C

valid_version() {
  local version=$1 id number='(0|[1-9][0-9]*)' ident='[0-9A-Za-z-]+'
  local pattern="^${number}\\.${number}\\.${number}(-${ident}(\\.${ident})*)?(\\+${ident}(\\.${ident})*)?$"
  [[ "$version" =~ $pattern ]] || return 1
  if [[ "${version%%+*}" == *-* ]]; then
    local ids=() pre=${version%%+*}
    IFS=. read -r -a ids <<< "${pre#*-}"
    for id in "${ids[@]}"; do
      [[ "$id" =~ ^[0-9]+$ && ${#id} -gt 1 && "$id" == 0* ]] && return 1
    done
  fi
  return 0
}

compare_identifier() {
  local left=$1 right=$2
  if [[ "$left" =~ ^[0-9]+$ && "$right" =~ ^[0-9]+$ ]]; then
    if [ "${#left}" -ne "${#right}" ]; then
      if [ "${#left}" -gt "${#right}" ]; then echo 1; else echo -1; fi
      return
    fi
  elif [[ "$left" =~ ^[0-9]+$ ]]; then echo -1; return
  elif [[ "$right" =~ ^[0-9]+$ ]]; then echo 1; return
  fi
  if [[ "$left" == "$right" ]]; then echo 0
  elif [[ "$left" > "$right" ]]; then echo 1
  else echo -1; fi
}

compare_versions() {
  local left=${1%%+*} right=${2%%+*} i result
  local a=() b=()
  IFS=. read -r -a a <<< "${left%%-*}"
  IFS=. read -r -a b <<< "${right%%-*}"
  for i in 0 1 2; do
    result=$(compare_identifier "${a[i]}" "${b[i]}")
    if [ "$result" != 0 ]; then echo "$result"; return; fi
  done
  if [ "$left" = "$right" ]; then echo 0; return; fi
  if [[ "$left" != *-* ]]; then echo 1; return; fi
  if [[ "$right" != *-* ]]; then echo -1; return; fi
  IFS=. read -r -a a <<< "${left#*-}"
  IFS=. read -r -a b <<< "${right#*-}"
  for ((i=0; i<${#a[@]} && i<${#b[@]}; i++)); do
    result=$(compare_identifier "${a[i]}" "${b[i]}")
    if [ "$result" != 0 ]; then echo "$result"; return; fi
  done
  if [ "${#a[@]}" -gt "${#b[@]}" ]; then echo 1
  elif [ "${#a[@]}" -lt "${#b[@]}" ]; then echo -1
  else echo 0; fi
}

tag_version() {
  local tag=$1 version=${1#artifact-tracking--v}
  if [[ "$tag" != artifact-tracking--v* ]] || ! valid_version "$version"; then
    echo "Invalid release tag: $tag" >&2
    return 1
  fi
  echo "$version"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    tag) tag_version "${2:-}" ;;
    newer)
      if ! valid_version "$2" || ! valid_version "$3"; then echo 'Invalid version' >&2; exit 1; fi
      if [ "$(compare_versions "$2" "$3")" = 1 ]; then echo newer
      else echo 'not newer' >&2; exit 1; fi ;;
    *) echo 'Usage: version.sh tag TAG | newer VERSION PREVIOUS' >&2; exit 1 ;;
  esac
fi
