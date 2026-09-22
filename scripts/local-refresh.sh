#!/bin/bash
# Scrape from this machine's home connection and publish the result to the
# repo's `data` branch, where the GitHub Pages deploy picks it up.
#
# Cinemark and AMC block GitHub's datacenter runners via Cloudflare, so this
# is what keeps the hosted site's data fresh. Installed as a launchd agent
# (see scripts/install-local-refresh.sh) that runs hourly by default.
#
# Run by hand from any checkout: ./scripts/local-refresh.sh
# The launchd agent runs it from its own checkout (~/.imax-monitor) with
# IMAX_SYNC_REPO=1, which fast-forwards that checkout to origin/main first.
# The sync never runs against a checkout you're editing.
set -euo pipefail

# launchd starts with a minimal PATH; make Homebrew's node/npm/gh visible
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$(dirname "$0")/.."

echo "=== $(date '+%Y-%m-%d %H:%M:%S') local refresh ($(pwd)) ==="

if [[ "${IMAX_SYNC_REPO:-}" == "1" ]]; then
  git fetch -q origin main
  git reset -q --hard origin/main
  # Reinstall deps only when the lockfile changed
  if [[ ! -d node_modules || ! -f node_modules/.lockfile-hash ]] ||
     ! cmp -s <(shasum package-lock.json) node_modules/.lockfile-hash; then
    npm ci --no-audit --no-fund --silent
    shasum package-lock.json > node_modules/.lockfile-hash
  fi
fi

# Token saved by the installer, so publishing doesn't depend on Keychain
# access or on which `gh` account happens to be active
TOKEN_FILE="$HOME/.config/imax-monitor/token"
if [[ -z "${GH_TOKEN:-}" && -r "$TOKEN_FILE" ]]; then
  GH_TOKEN="$(<"$TOKEN_FILE")"
  export GH_TOKEN
fi

# Fill gaps (rate-limited dates, uncounted seat maps) from the live site
export PREV_SNAPSHOT_URL="https://rahulramath.github.io/imax-ticket-monitor/data/snapshot.json"

npm run --silent scrape
npm run --silent publish-snapshot
