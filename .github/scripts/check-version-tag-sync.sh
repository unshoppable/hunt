#!/usr/bin/env bash
# Asserts every release project's package.json version has a matching git tag.
# Run from the repo root. Exits 1 with a list of missing tags if any drift is detected.
set -euo pipefail

# Discover every project.json under apps/ and libs/.
# Parallel indexed arrays (works on bash 3.2+, unlike `declare -A`).
project_names=()
project_roots=()
while IFS= read -r project_json; do
  name=$(jq -r '.name // empty' "$project_json")
  if [[ -n "$name" ]]; then
    project_names+=("$name")
    project_roots+=("${project_json%/project.json}")
  fi
done < <(find apps libs -name project.json -not -path '*/node_modules/*')

lookup_root() {
  local target="$1"
  local index
  for index in "${!project_names[@]}"; do
    if [[ "${project_names[$index]}" == "$target" ]]; then
      echo "${project_roots[$index]}"
      return 0
    fi
  done
  return 1
}

missing=()
checked=0
while IFS= read -r project; do
  if ! root=$(lookup_root "$project"); then
    echo "::warning::no project.json for release project '$project'"
    continue
  fi
  version=$(jq -r '.version // empty' "$root/package.json")
  [[ -n "$version" ]] || continue
  tag="$project@$version"
  checked=$((checked + 1))
  if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
    missing+=("$tag  ($root)")
  fi
done < <(jq -r '.release.projects[]' nx.json)

if (( ${#missing[@]} > 0 )); then
  echo "::error::nx release bumped versions but ${#missing[@]} project(s) have no matching git tag:"
  printf '  - %s\n' "${missing[@]}"
  exit 1
fi

echo "✓ All ${checked} release projects have matching git tags"
