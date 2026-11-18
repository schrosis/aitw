#!/usr/bin/env bash
# Checks and verifies the FSL specifications in specs/.
#
# A check that passes with warnings fails here, so that every declaration keeps a requirement ID.
set -euo pipefail

shopt -s nullglob
specs=(specs/*.fsl)
if [ "${#specs[@]}" -eq 0 ]; then
  echo "No specifications to check"
  exit 0
fi

for spec in "${specs[@]}"; do
  echo "::group::$spec"
  fslc check --strict-tags "$spec" | jq -e '.result == "ok" and (.warnings | length) == 0' > /dev/null || {
    fslc check --strict-tags "$spec" || true
    echo "::error file=$spec::fslc check failed or reported warnings"
    exit 1
  }
  fslc lint "$spec" > /dev/null || {
    fslc lint "$spec" || true
    echo "::error file=$spec::fslc lint reported findings"
    exit 1
  }
  for engine in bmc induction; do
    fslc verify --engine "$engine" --depth 8 "$spec" > /dev/null || {
      fslc verify --engine "$engine" --depth 8 "$spec" || true
      echo "::error file=$spec::fslc verify --engine $engine failed"
      exit 1
    }
  done
  echo "::endgroup::"
done
