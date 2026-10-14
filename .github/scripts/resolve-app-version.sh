#!/usr/bin/env bash
# Single source of app-version resolution — ci-build-and-deploy appends the printed lines to
# $GITHUB_ENV, detect-affected-apps.sh calls it per app. Run from the repo root; requires node, jq
# and installed npm dependencies (the app root is looked up via nx).
#
# Usage: resolve-app-version.sh <project> [expected-version]
#
# The version describes what is deployed for the app at HEAD:
#  - v<package.json version> (maintained by nx release) when that version is a semantic version,
#    its <project>@<version> release tag lies in HEAD's history and the app has not changed since
#    (nx affected between the tag's commit and HEAD). DEPLOY_SHA is then the tag's commit: with
#    independent versioning a release commit only bumps the apps that changed, so most apps' current
#    release was cut a few commits back.
#  - otherwise v-<short commit hash>, so an unreleased commit is deployable without releasing it
#    first; DEPLOY_SHA is HEAD.
#
# The expected-version argument is a consistency check, not an override: a dispatching workflow
# passes the version it already resolved so its run title can show it, and a mismatch means the two
# disagree about what is being deployed.
#
# Prints $GITHUB_ENV-format lines on stdout (diagnostics and errors go to stderr):
#   APP_VERSION=<resolved version>
#   SEMVER_TAG=<the bare semver on a tagged release, empty otherwise>
#   DEPLOY_SHA=<the commit whose artifact is deployed>
set -euo pipefail

PROJECT="$1"
EXPECTED_VERSION="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

APP_ROOT=$("$SCRIPT_DIR/nx-project-field.sh" "$PROJECT" .root)
PACKAGE_VERSION=$(node -p "require('./$APP_ROOT/package.json').version")
HEAD_COMMIT_HASH=$(git rev-parse HEAD)

VERSION_TAG_COMMIT_HASH=$(git rev-parse --verify --quiet "refs/tags/${PROJECT}@${PACKAGE_VERSION}^{commit}" || true)

IS_TAGGED_RELEASE=false
if [[ "$PACKAGE_VERSION" =~ ^${SEMVER_PATTERN}$ ]] && [ -n "$VERSION_TAG_COMMIT_HASH" ] && git merge-base --is-ancestor "$VERSION_TAG_COMMIT_HASH" "$HEAD_COMMIT_HASH"; then
  IS_TAGGED_RELEASE=true
fi

if [ "$IS_TAGGED_RELEASE" = true ] && [ "$VERSION_TAG_COMMIT_HASH" != "$HEAD_COMMIT_HASH" ]; then
  IS_CHANGED_SINCE_RELEASE=$(npx nx show projects --affected --base="$VERSION_TAG_COMMIT_HASH" --head="$HEAD_COMMIT_HASH" --type=app --json | jq --arg project "$PROJECT" 'index($project) != null')
  if [ "$IS_CHANGED_SINCE_RELEASE" = true ]; then
    echo "$PROJECT changed since its ${PROJECT}@${PACKAGE_VERSION} release ($VERSION_TAG_COMMIT_HASH) - deploying HEAD as an unreleased version" >&2
    IS_TAGGED_RELEASE=false
  fi
fi

if [ "$IS_TAGGED_RELEASE" = true ]; then
  VERSION="v$PACKAGE_VERSION"
  SEMVER_TAG="$PACKAGE_VERSION"
  DEPLOY_SHA="$VERSION_TAG_COMMIT_HASH"
else
  VERSION="v-$(git rev-parse --short HEAD)"
  SEMVER_TAG=""
  DEPLOY_SHA="$HEAD_COMMIT_HASH"
fi

if [ -n "$EXPECTED_VERSION" ] && [ "$EXPECTED_VERSION" != "$VERSION" ]; then
  echo "::error::$PROJECT: caller expects version '$EXPECTED_VERSION' but $HEAD_COMMIT_HASH resolves to '$VERSION' - deploy the commit that version was released from, or leave the version empty to deploy this commit as '$VERSION'." >&2
  exit 1
fi

echo "Resolved APP_VERSION=$VERSION for $PROJECT (tagged release: $IS_TAGGED_RELEASE, released at: $DEPLOY_SHA)" >&2

echo "APP_VERSION=$VERSION"
echo "SEMVER_TAG=$SEMVER_TAG"
echo "DEPLOY_SHA=$DEPLOY_SHA"
