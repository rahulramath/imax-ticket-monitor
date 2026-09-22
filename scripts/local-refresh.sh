#!/bin/bash
# Scrape from this machine's home connection and publish the result to the
# repo's `data` branch, where the GitHub Pages deploy picks it up.
#
# Cinemark and AMC block GitHub's datacenter runners via Cloudflare, so this
# is what keeps the hosted site's data fresh. Installed as a launchd agent
# (see scripts/install-local-refresh.sh) that runs hourly; the interval can be
# raised to 12h or 24h in the plist if hourly is more than you want.
set -euo pipefail

# launchd starts with a minimal PATH; make Homebrew's node/npm/gh visible
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$(dirname "$0")/.."

# Fill gaps (rate-limited dates, uncounted seat maps) from the live site
export PREV_SNAPSHOT_URL="https://rahulramath.github.io/imax-ticket-monitor/data/snapshot.json"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') local refresh ==="
npm run --silent scrape
npm run --silent publish-snapshot
