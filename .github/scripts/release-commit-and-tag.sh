#!/usr/bin/env bash
# Runs the local half of a release for ci-release: nx release bumps versions, writes changelogs and
# <app>@<version> tags and commits, then the commit is amended with a message that summarises the
# released versions. Push and deploy stay in the workflow. Run from the repo root of a full-depth
# master checkout; requires node and installed npm dependencies.
#
# Usage: release-commit-and-tag.sh
# Requires GITHUB_OUTPUT in the environment; DEPLOY_TAG names the tag ci-release moves onto the
# commit deployed last (default deployed/prod).
#
# Writes to $GITHUB_OUTPUT:
#   has_changes=<true when nx release produced a new commit that still has to be pushed>
#   is_release=<true when HEAD carries <app>@<version> tags and HEAD is not deployed yet — the
#               commit created just now, or one an earlier run pushed but failed to deploy>
#   release_sha=<HEAD, only when is_release is true>
#   client_version=<the version of client@<version> on HEAD, empty when this release has none>
#   session_version=<the version of session@<version> on HEAD, empty when this release has none>
set -euo pipefail

DEPLOY_TAG="${DEPLOY_TAG:-deployed/prod}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

: "${GITHUB_OUTPUT:?must be set}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

COMMIT_BEFORE_RELEASE=$(git rev-parse HEAD)
npx nx release --skip-publish
COMMIT_AFTER_RELEASE=$(git rev-parse HEAD)

if [ "$COMMIT_BEFORE_RELEASE" = "$COMMIT_AFTER_RELEASE" ]; then
  echo "Nothing to release"
  echo "has_changes=false" >> "$GITHUB_OUTPUT"
else
  # The subject of the commit that triggered the release, suffixed with the released <app>@<version>
  # tags, so the master history shows which versions a release commit cut.
  COMMIT_DESCRIPTION=$(git log HEAD~1 -1 --format=%s | sed 's/^[^:]*: //')
  RELEASE_TAGS=$(git tag --points-at HEAD | grep -E "@${SEMVER_PATTERN}$" | sort | paste -sd, - | sed 's/,/, /g' || true)
  if [ -n "$RELEASE_TAGS" ]; then
    COMMIT_DESCRIPTION="${COMMIT_DESCRIPTION} (${RELEASE_TAGS})"
  fi

  git commit --amend -m "chore(release): ${COMMIT_DESCRIPTION}"

  # Move the tags from the pre-amend commit to the amended HEAD; a tag left on the discarded commit
  # would be pushed pointing at a commit that is not on master.
  git tag --points-at HEAD@{1} | xargs -r -I {} git tag -af {} -m "{}" HEAD

  echo "has_changes=true" >> "$GITHUB_OUTPUT"
fi

# HEAD is a release commit when it carries <app>@<version> tags. Once the deploy tag sits on HEAD the
# release is complete, and a later no-op run (a merge that arrived while the previous run released
# it, a manual dispatch) must not deploy it again.
DEPLOYED_COMMIT=$(git rev-parse --verify --quiet "refs/tags/${DEPLOY_TAG}^{commit}" || true)
if git tag --points-at HEAD | grep -Eq "@${SEMVER_PATTERN}$" && [ "$DEPLOYED_COMMIT" != "$(git rev-parse HEAD)" ]; then
  CLIENT_TAG=$(git tag --points-at HEAD | grep -E "^client@${SEMVER_PATTERN}$" | head -n1 || true)
  SESSION_TAG=$(git tag --points-at HEAD | grep -E "^session@${SEMVER_PATTERN}$" | head -n1 || true)
  {
    echo "is_release=true"
    echo "release_sha=$(git rev-parse HEAD)"
    echo "client_version=${CLIENT_TAG#client@}"
    echo "session_version=${SESSION_TAG#session@}"
  } >> "$GITHUB_OUTPUT"
else
  {
    echo "is_release=false"
    echo "client_version="
    echo "session_version="
  } >> "$GITHUB_OUTPUT"
fi
