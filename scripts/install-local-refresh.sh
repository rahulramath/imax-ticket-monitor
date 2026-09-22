#!/bin/bash
# Install (or remove) the launchd agent that scrapes from this Mac on a
# schedule and publishes the snapshot to the repo's `data` branch.
#
#   scripts/install-local-refresh.sh              # hourly (default)
#   scripts/install-local-refresh.sh 43200        # every 12 hours
#   scripts/install-local-refresh.sh 86400        # daily
#   scripts/install-local-refresh.sh --uninstall
#
# The agent runs from its own checkout at ~/.imax-monitor (kept in sync with
# origin/main) rather than from this working copy: macOS blocks background
# jobs from reading ~/Documents, ~/Desktop and ~/Downloads, and this way an
# edit-in-progress here can't break the hourly run either.
#
# If the Mac is asleep when a run is due, launchd runs it once on wake.
# Logs: ~/Library/Logs/imax-monitor.log
set -euo pipefail

LABEL="com.rahulramath.imax-monitor"
REPO_URL="https://github.com/rahulramath/imax-ticket-monitor.git"
GH_USER="${GH_USER:-rahulramath}"
AGENT_DIR="$HOME/.imax-monitor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/imax-monitor.log"
TOKEN_FILE="$HOME/.config/imax-monitor/token"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$TOKEN_FILE"
  echo "Removed $LABEL (checkout at $AGENT_DIR left in place; delete it if you like)"
  exit 0
fi

INTERVAL="${1:-3600}"

# Dedicated checkout for the agent
if [[ ! -d "$AGENT_DIR/.git" ]]; then
  git clone -q "$REPO_URL" "$AGENT_DIR"
fi
git -C "$AGENT_DIR" fetch -q origin main
git -C "$AGENT_DIR" reset -q --hard origin/main
chmod +x "$AGENT_DIR/scripts/local-refresh.sh"

# Personal-account token for publishing (gh's own store may be in Keychain,
# which background jobs can't reliably read, and the active gh account may
# be a different login)
mkdir -p "$(dirname "$TOKEN_FILE")" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
gh auth token -u "$GH_USER" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

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
    <string>$AGENT_DIR/scripts/local-refresh.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>IMAX_SYNC_REPO</key>
    <string>1</string>
  </dict>
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
echo "Installed $LABEL: runs every $INTERVAL seconds from $AGENT_DIR (and once now). Log: $LOG"
