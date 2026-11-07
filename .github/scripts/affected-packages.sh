#!/usr/bin/env bash
# Selects the workspace packages that CI must check.
#
# Usage: affected-packages.sh [BASE_SHA]
#
# Writes these outputs to $GITHUB_OUTPUT, or to standard output when it is unset:
#   scope        all, affected, or none
#   build_args   pnpm arguments that select packages to build, including dependencies
#   check_args   pnpm arguments that select packages to check
set -euo pipefail

base="${1:-}"
output="${GITHUB_OUTPUT:-/dev/stdout}"

write() {
  printf 'scope=%s\nbuild_args=%s\ncheck_args=%s\n' "$1" "$2" "$3" >> "$output"
}

if [ -z "$base" ]; then
  write all "-r" "-r"
  exit 0
fi

# Documentation changes do not require package checks.
docs_pattern='^(docs/|\.claude/)|\.md$|^LICENSE$'
root_changed=false
packages_changed=false
while IFS= read -r file; do
  if [[ $file =~ $docs_pattern ]]; then
    continue
  elif [[ $file == packages/* ]]; then
    packages_changed=true
  else
    root_changed=true
  fi
done < <(git diff --name-only "$base...HEAD")

if $root_changed; then
  write all "-r" "-r"
elif $packages_changed; then
  mapfile -t dirs < <(
    pnpm --filter "...[$base]" --changed-files-ignore-pattern '**/*.md' ls -r --depth -1 --json \
      | jq -r --arg root "$PWD" '.[] | select(.path != $root) | "./" + (.path | ltrimstr($root + "/"))'
  )
  build_args=""
  check_args=""
  for dir in "${dirs[@]}"; do
    build_args+="--filter={$dir}... "
    check_args+="--filter={$dir} "
  done
  write affected "${build_args% }" "${check_args% }"
else
  write none "" ""
fi
