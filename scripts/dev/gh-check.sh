#!/bin/sh
# Warns when gh cannot serve project-sync: a token without the `project` scope, or a gh
# older than 2.94, which lacks the blocker commands. It only warns and always exits 0.
# It is silent when gh is missing, when gh prints no scopes (a fine-grained token, no login)
# and when it cannot read the version. Called by `make init`. Tests: gh-check.test.sh.
command -v gh >/dev/null 2>&1 || exit 0

# The scopes of the token for github.com, where the project lives. Pin the host: gh prints
# the hosts in no fixed order, so the first scopes line can belong to another host.
# --active limits the output to the signed-in account. A gh that does not know the flag
# says so, and only then does the plain call run.
status="$(gh auth status --active --hostname github.com 2>&1)"
case "$status" in
*"unknown flag"*) status="$(gh auth status --hostname github.com 2>&1)" ;;
esac
scopes="$(printf '%s\n' "$status" | sed -n 's/.*Token scopes: //p' | head -n 1)"
# A scope matches as a whole word: `read:project` is not `project`.
if [ -n "$scopes" ] && ! printf '%s\n' "$scopes" | tr -d "' " | tr ',' '\n' | grep -qx project; then
	printf '%-9s: WARNING the gh token lacks the project scope, so project-sync cannot write. Run: gh auth refresh -s project, or put a classic token with the project scope in GH_TOKEN.\n' 'gh scopes'
fi

# gh 2.94 added `gh issue view --json blockedBy` and the --blocked-by flags. Compare the
# major and minor numbers as numbers: 2.102 is newer than 2.94.
version="$(gh --version 2>/dev/null | sed -n '1s/^gh version \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')"
if [ -n "$version" ]; then
	major="${version% *}"
	minor="${version#* }"
	if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 94 ]; }; then
		printf '%-9s: WARNING gh %s.%s is older than 2.94, so the blocker commands fail (gh issue view --json blockedBy, --blocked-by). Upgrade gh.\n' 'gh version' "$major" "$minor"
	fi
fi
exit 0
