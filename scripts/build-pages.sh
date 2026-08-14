#!/usr/bin/env bash
set -euo pipefail

export GITHUB_PAGES=true
export NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH:-/BuildplateNester}"

./node_modules/.bin/vinext build
