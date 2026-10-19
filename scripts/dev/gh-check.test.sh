#!/usr/bin/env bash
# Tests for gh-check.sh with a fake gh. They need no login and no network. Run: make test-scripts.
set -u

here="$(cd "$(dirname "$0")" && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0

# The fake gh answers `--version` and `auth status`. The environment steers it:
#   FAKE_VERSION    what --version prints (default 2.102.0)
#   FAKE_SCOPES     the token scopes of github.com; "-" prints no scopes line (default: project and repo)
#   FAKE_OTHER      the token scopes of another host. A call without --hostname github.com prints it first.
#   FAKE_NO_ACTIVE  reject --active as an old gh does
#   FAKE_ACTIVE_OFF reject --active as a gh with no login does: no flag error, no scopes
mkdir -p "$tmp/bin"
cat >"$tmp/bin/gh" <<'EOF'
#!/bin/sh
if [ "$1" = "--version" ]; then
	echo "gh version ${FAKE_VERSION:-2.102.0} (2026-09-30)"
	echo "https://github.com/cli/cli/releases/tag/v${FAKE_VERSION:-2.102.0}"
	exit 0
fi
[ "$1" = auth ] && [ "$2" = status ] || exit 2
shift 2
active=no
pinned=no
while [ $# -gt 0 ]; do
	case "$1" in
	--active) active=yes ;;
	--hostname) [ "$2" = github.com ] && pinned=yes; shift ;;
	esac
	shift
done
if [ "$active" = yes ] && [ -n "${FAKE_NO_ACTIVE:-}" ]; then
	echo "unknown flag: --active" >&2
	exit 1
fi
if [ "$active" = yes ] && [ -n "${FAKE_ACTIVE_OFF:-}" ]; then
	echo "You are not logged into any accounts on github.com" >&2
	exit 1
fi
block() { # block <host> <scopes>
	echo "$1"
	echo "  ✓ Logged in to $1 account octo (keyring)"
	echo "  - Active account: true"
	if [ "$2" = "-" ]; then echo "  - Token: github_pat_************"; else echo "  - Token scopes: $2"; fi
}
[ "$pinned" = no ] && [ -n "${FAKE_OTHER:-}" ] && block ghe.example.com "$FAKE_OTHER"
block github.com "${FAKE_SCOPES:-'project', 'repo'}"
EOF
chmod +x "$tmp/bin/gh"

# A PATH with the tools that the script uses and no gh.
mkdir -p "$tmp/nogh"
for tool in sed tr grep head; do ln -s "$(command -v "$tool")" "$tmp/nogh/$tool"; done

# check <name> <quiet|text> [VAR=value ...]: run the script. quiet: no output. text: the output has it.
# The script only warns, so the exit code must be 0 either way.
check() {
	local name=$1 want=$2 out status
	shift 2
	out="$(env "$@" PATH="${CHECK_PATH:-$tmp/bin:/usr/bin:/bin}" "$here/gh-check.sh" 2>&1)"
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "FAIL $name (exit $status)"
		fails=$((fails + 1))
	elif { [ "$want" = quiet ] && [ -z "$out" ]; } || { [ "$want" != quiet ] && printf '%s' "$out" | grep -q -- "$want"; }; then
		echo "ok   $name"
	else
		echo "FAIL $name"
		printf '     wanted: %s\n     got:    %s\n' "$want" "${out:-(nothing)}"
		fails=$((fails + 1))
	fi
}

# The token scope.
check "warns when the project scope is missing" "lacks the project scope" FAKE_SCOPES="'gist', 'repo', 'workflow'"
check "warns when only read:project is there" "lacks the project scope" FAKE_SCOPES="'read:project', 'repo'"
check "tells how to fix it with GH_TOKEN too" "classic token with the project scope in GH_TOKEN" FAKE_SCOPES="'repo'"
check "is quiet with the project scope" quiet FAKE_SCOPES="'gist', 'project', 'repo'"
check "is quiet when gh prints no scopes line" quiet FAKE_SCOPES="-"

# The host. A call without --hostname github.com prints another host first.
check "reads github.com when another host with the project scope prints first" "lacks the project scope" \
	FAKE_OTHER="'project', 'repo'" FAKE_SCOPES="'repo'"
check "reads github.com when another host without the project scope prints first" quiet \
	FAKE_OTHER="'repo'" FAKE_SCOPES="'project', 'repo'"

# The --active flag. A gh that does not know it gets the plain call, and only then.
check "falls back to the plain call when gh does not know --active" "lacks the project scope" \
	FAKE_NO_ACTIVE=1 FAKE_SCOPES="'repo'"
check "does not fall back when --active fails for another reason" quiet \
	FAKE_ACTIVE_OFF=1 FAKE_SCOPES="'repo'"

# The version. The blocker commands need gh 2.94.0 or newer.
check "warns when gh is older than 2.94" "older than 2.94" FAKE_VERSION=2.93.1
check "warns when gh has an older major version" "older than 2.94" FAKE_VERSION=1.14.0
check "is quiet with gh 2.94.0, the minimum" quiet FAKE_VERSION=2.94.0
check "is quiet with gh 2.102.0: the minor version compares as a number" quiet FAKE_VERSION=2.102.0
check "is quiet with a newer major version" quiet FAKE_VERSION=3.0.0
check "is quiet when the version has no number" quiet FAKE_VERSION=unknown
check "gives the version warning next to the scope warning" "older than 2.94" FAKE_VERSION=2.90.0 FAKE_SCOPES="'repo'"

# No gh at all: init lists it as optional.
CHECK_PATH="$tmp/nogh" check "is quiet when gh is missing" quiet

[ "$fails" -eq 0 ] || { echo "$fails test(s) failed"; exit 1; }
echo "all gh-check tests passed"
