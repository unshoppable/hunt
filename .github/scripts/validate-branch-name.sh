#!/bin/sh
# Validate that a branch name follows the convention: feat|feature|fix|chore/<scope>/<branch-name>
#
# Usage:
#   .github/scripts/validate-branch-name.sh               # validates the current branch
#   .github/scripts/validate-branch-name.sh <branch-name> # validates the given name (e.g. CI head_ref)
#
# Exits 0 when valid or exempt, 1 otherwise. Emits a GitHub Actions ::error::
# annotation when run in CI ($GITHUB_ACTIONS), colored stderr otherwise.

branch_name="${1:-$(git rev-parse --abbrev-ref HEAD)}"

valid_pattern='^(feat|feature|fix|chore)/[^/]+/.+$'
# Branches that legitimately don't follow the human convention. dr-claude branches are
# bot-created as dr-claude/feature/<issue>-<description> (no scope segment).
exempt_pattern='^(master|main|develop|HEAD)$|^(release-please|dependabot|renovate)([/-]|$)|^dr-claude/'

if printf '%s' "$branch_name" | grep -Eq "$exempt_pattern"; then
  echo "Skipping branch-name check for exempt branch: $branch_name"
  exit 0
fi

if printf '%s' "$branch_name" | grep -Eq "$valid_pattern"; then
  echo "Branch name \"$branch_name\" OK"
  exit 0
fi

message="Branch \"$branch_name\" does not follow the naming convention feat|feature|fix|chore/<scope>/<branch-name> (e.g. feature/general/extend-catalogs)"
if [ "$GITHUB_ACTIONS" = "true" ]; then
  echo "::error::$message"
else
  printf >&2 "\n\033[31m✘ %s\033[0m\n\n" "$message"
fi
exit 1
