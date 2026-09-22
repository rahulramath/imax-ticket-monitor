#!/bin/bash
# Install (or remove) the launchd agent that runs scripts/local-refresh.sh on
# a schedule from this Mac.
#
#   scripts/install-local-refresh.sh              # hourly (default)
#   scripts/install-local-refresh.sh 43200        # every 12 hours
#   scripts/install-local-refresh.sh 86400        # daily
#   scripts/install-local-refresh.sh --uninstall
#
# If the Mac is asleep when a run is due, launchd runs it once on wake.
# Logs: ~/Library/Logs/imax-monitor.log
set -euo pipefail

LABEL="com.rahulramath.imax-monitor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/imax-monitor.log"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/local-refresh.sh"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

INTERVAL="${1:-3600}"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
chmod +x "$SCRIPT"

# Replace any existing agent
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT</string>
  </array>
  <key>StartInterval</key>
  <integer>$INTERVAL</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL: runs every $INTERVAL seconds (and once now). Log: $LOG"
