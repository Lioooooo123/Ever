#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_LINK_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  if [[ "$SCRIPT_PATH" != /* ]]; then
    SCRIPT_PATH="$SCRIPT_LINK_DIR/$SCRIPT_PATH"
  fi
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check for --no-env flag
NO_ENV=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  while IFS= read -r name; do
    unset "$name"
  done < <("$REPO_ROOT/node_modules/.bin/tsx" --tsconfig "$REPO_ROOT/tsconfig.json" "$REPO_ROOT/scripts/list-provider-auth-env.ts")
  # GitHub CLI credentials are not model-provider settings, but must not leak into isolated smoke tests.
  unset GH_TOKEN
  unset GITHUB_TOKEN
  echo "Running without API keys..."
fi

"$REPO_ROOT/node_modules/.bin/tsx" --tsconfig "$REPO_ROOT/tsconfig.json" "$REPO_ROOT/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
