#!/usr/bin/env bash
#
# Remove the daily "fitness brief" launchd job (macOS).
# Unloads the agent and deletes the installed plist. Safe to run if the
# job was never installed.
#
# Usage:  ./ops/uninstall-launchd.sh
set -euo pipefail

LABEL="com.localfitness.brief"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ -f "$PLIST_DEST" ]]; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  echo "Removed $LABEL ($PLIST_DEST)"
else
  echo "$LABEL not installed (no plist at $PLIST_DEST) — nothing to do."
fi
