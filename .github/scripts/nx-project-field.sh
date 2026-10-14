#!/usr/bin/env bash
# Prints one field of an Nx project's configuration, addressed as a jq filter. Single source of
# `nx show project` reads, so the JSON shape is parsed in one place. Run from anywhere inside the
# repo; requires node, jq and installed npm dependencies.
#
# Usage: nx-project-field.sh <project> <jq-filter>
#   nx-project-field.sh gateway .root
#   nx-project-field.sh gateway '.targets.build.outputs[0]'
#
# Exits 1 when the field is absent, so a renamed target fails the caller instead of handing it the
# string "null".
set -euo pipefail

PROJECT="${1:?usage: nx-project-field.sh <project> <jq-filter>}"
FIELD_FILTER="${2:?usage: nx-project-field.sh <project> <jq-filter>}"

FIELD_VALUE=$(npx nx show project "$PROJECT" --json | jq -r "$FIELD_FILTER")

if [ -z "$FIELD_VALUE" ] || [ "$FIELD_VALUE" = "null" ]; then
  echo "::error::nx project '$PROJECT' has no '$FIELD_FILTER'" >&2
  exit 1
fi

echo "$FIELD_VALUE"
