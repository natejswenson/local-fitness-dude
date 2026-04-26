#!/usr/bin/env bash
# Install/reload the daily launchd job for local-fitness.
# Idempotent: re-running re-installs over the existing copy.
set -euo pipefail

LABEL="com.local-fitness.daily"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_PLIST="$PROJECT_ROOT/ops/$LABEL.plist"
DEST_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS_DIR="$PROJECT_ROOT/logs"

mkdir -p "$HOME/Library/LaunchAgents" "$LOGS_DIR"

# Unload any existing job (ignore errors if not loaded)
launchctl unload "$DEST_PLIST" 2>/dev/null || true

cp "$SRC_PLIST" "$DEST_PLIST"
launchctl load "$DEST_PLIST"

echo "Installed: $DEST_PLIST"
echo "Status:"
launchctl list | grep "$LABEL" || echo "  (not yet listed — try: launchctl print gui/\$(id -u)/$LABEL)"
echo
echo "Trigger now:  launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo "Tail logs:    tail -f $LOGS_DIR/daily.{out,err}.log"
echo "Uninstall:    launchctl unload $DEST_PLIST && rm $DEST_PLIST"
