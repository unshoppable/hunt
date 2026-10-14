#!/usr/bin/env bash
# Definitions shared by the .github/scripts/* CI scripts. Sourced, never executed:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/lib.sh"

# The one version shape this repo releases: MAJOR.MINOR.PATCH with an optional prerelease, never
# build metadata — a released version doubles as a file name (the tarball ci-build-and-deploy packs)
# and as the .version a VM reports, both kept free of '+'.
#
# Unanchored, so each call site anchors it for what it matches against: a bare version as
# ^$SEMVER_PATTERN$, a <project>@<version> tag as @$SEMVER_PATTERN$. Both anchors are load-bearing —
# without the trailing one, '1.2.3.4' and '1.2.3+build' match on their '1.2.3' prefix, and a tag scan
# would then report as released a version resolve-app-version.sh refuses to deploy.
SEMVER_PATTERN='[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?'
