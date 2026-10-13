#!/usr/bin/env bash
# Lists the deployable apps affected since a base ref, as the matrix ci-nx-affected-deploy fans its
# per-app deploys out over. Run from the repo root; requires node, jq and installed npm dependencies.
#
# Usage: detect-affected-apps.sh <base-ref>
# Requires GITHUB_OUTPUT in the environment.
#
# Deployable are the apps with a folder in .github/config/, the server apps CI deploys onto the
# gateway VM; the desktop app is released by ci-release's publish-client job instead. The list
# follows the folder names' alphabetical order, which ci-nx-affected-deploy deploys in: gateway
# before session.
#
# Writes to $GITHUB_OUTPUT:
#   apps=[{"name":"<app>","version":"<version>"}, ...]
#   has_affected=<true when the list is non-empty>
set -euo pipefail

BASE_REF="${1:?usage: detect-affected-apps.sh <base-ref>}"
: "${GITHUB_OUTPUT:?must be set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOYABLE_APPS=()
for config_dir in "$SCRIPT_DIR"/../config/*/; do
  DEPLOYABLE_APPS+=("$(basename "$config_dir")")
done
if [ ${#DEPLOYABLE_APPS[@]} -eq 0 ] || [ "${DEPLOYABLE_APPS[0]}" = "*" ]; then
  echo "::error::No deploy config directories found under .github/config"
  exit 1
fi

echo "Comparing against: $BASE_REF"

# --json, not the default listing: nx switches its plain output between one-project-per-line and a
# JSON array depending on the environment it thinks it runs in.
AFFECTED=$(npx nx show projects --affected --base="$BASE_REF" --head=HEAD --type=app --json | jq -r '.[]')

AFFECTED_DEPLOYABLE=()
while IFS= read -r app; do
  if [ -z "$app" ]; then continue; fi
  for deployable in "${DEPLOYABLE_APPS[@]}"; do
    if [ "$app" = "$deployable" ]; then
      AFFECTED_DEPLOYABLE+=("$app")
      break
    fi
  done
done <<< "$AFFECTED"

if [ ${#AFFECTED_DEPLOYABLE[@]} -eq 0 ]; then
  echo "No deployable apps affected"
  {
    echo "apps=[]"
    echo "has_affected=false"
  } >> "$GITHUB_OUTPUT"
  exit 0
fi

ENTRIES=()
for app in "${AFFECTED_DEPLOYABLE[@]}"; do
  VERSION=$("$SCRIPT_DIR/resolve-app-version.sh" "$app" | sed -n 's/^APP_VERSION=//p')
  ENTRIES+=("$(jq -nc --arg name "$app" --arg version "$VERSION" '{name: $name, version: $version}')")
done

APPS_JSON=$(printf '%s\n' "${ENTRIES[@]}" | jq -sc .)
echo "Affected deployable apps: $APPS_JSON"

{
  echo "apps=$APPS_JSON"
  echo "has_affected=true"
} >> "$GITHUB_OUTPUT"
