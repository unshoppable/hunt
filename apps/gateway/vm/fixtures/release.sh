#!/bin/bash
# Lays out the CI release $2 of role $1 (gateway or session) below /tmp/releases from the gateway artifact, with a hash
# of its own, and prints its folder. A session release only needs what `hunt-ctl stage-session` checks.
set -euo pipefail
dir=/tmp/releases/$1-$2
rm -rf "$dir"
mkdir -p /tmp/releases
cp -R /artifact "$dir"
if [[ $1 == session ]]; then
  mkdir -p "$dir/relay"
  echo 'export {};' >"$dir/relay/main.mjs"
fi
echo "$2" >"$dir/.version"
printf '%s' "$1 $2" | sha256sum | cut -c1-16 >"$dir/.hash"
echo "$dir"
