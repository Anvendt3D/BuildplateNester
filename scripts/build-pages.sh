#!/usr/bin/env bash
set -euo pipefail

export GITHUB_PAGES=true

./node_modules/.bin/vinext build
