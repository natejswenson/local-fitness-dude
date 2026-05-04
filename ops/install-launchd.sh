#!/usr/bin/env bash
# Install/reload the daily launchd job for local-fitness.
# Renders ops/com.local-fitness.daily.plist.template into a host-specific
# plist (substituting absolute paths) and loads it. Idempotent —
# re-running re-installs over the existing copy.
set -euo pipefail

LABEL="com.local-fitness.daily"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_TEMPLATE="$PROJECT_ROOT/ops/$LABEL.plist.template"
RENDERED_PLIST="$PROJECT_ROOT/ops/$LABEL.plist.rendered"
DEST_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS_DIR="$PROJECT_ROOT/logs"

if [[ ! -f "$SRC_TEMPLATE" ]]; then
    echo "Template missing: $SRC_TEMPLATE" >&2
    exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGS_DIR"

# Render the template — sed with `|` delimiter avoids escaping the slashes
# in the absolute paths.
sed \
    -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
    -e "s|__HOME__|$HOME|g" \
    "$SRC_TEMPLATE" > "$RENDERED_PLIST"

# Unload any existing job (ignore errors if not loaded)
launchctl unload "$DEST_PLIST" 2>/dev/null || true

cp "$RENDERED_PLIST" "$DEST_PLIST"
launchctl load "$DEST_PLIST"

echo "Installed: $DEST_PLIST"
echo "Status:"
launchctl list | grep "$LABEL" || echo "  (not yet listed — try: launchctl print gui/\$(id -u)/$LABEL)"
echo
echo "Trigger now:  launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo "Tail logs:    tail -f $LOGS_DIR/daily.{out,err}.log"
echo "Uninstall:    launchctl unload $DEST_PLIST && rm $DEST_PLIST"
