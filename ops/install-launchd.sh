#!/usr/bin/env bash
#
# Install the daily "fitness brief" launchd job (macOS).
#
# Resolves host-specific absolute paths (the `uv` binary + this repo's
# root), fills them into ops/com.localfitness.brief.plist.template, writes
# the result to ~/Library/LaunchAgents/, and (re)loads it. Idempotent:
# re-running unloads any existing job first.
#
# The job runs `fitness brief` daily at 06:30. It reads CLAUDE_CODE_OAUTH_TOKEN
# from <repo>/.env (auto-loaded by the CLI) — set that before relying on the
# scheduled run, or the brief composition will fail with no token.
#
# Usage:  ./ops/install-launchd.sh
set -euo pipefail

LABEL="com.localfitness.brief"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/com.localfitness.brief.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer is macOS-only (launchd). On Linux, schedule" >&2
  echo "'uv run fitness brief' with cron/systemd instead." >&2
  exit 1
fi

UV_BIN="$(command -v uv || true)"
if [[ -z "$UV_BIN" ]]; then
  echo "Could not find 'uv' on PATH. Install uv (https://docs.astral.sh/uv/)" >&2
  echo "then re-run this script." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "warning: $REPO_ROOT/.env not found — the scheduled job needs" >&2
  echo "         CLAUDE_CODE_OAUTH_TOKEN there (the CLI auto-loads .env)." >&2
  echo "         Installing the job anyway; create .env before 06:30." >&2
fi

mkdir -p "$REPO_ROOT/logs"
mkdir -p "$HOME/Library/LaunchAgents"

# Render the template with the resolved absolute paths. Using a non-`/`
# sed delimiter so paths containing `/` substitute cleanly.
sed -e "s|__UV_BIN__|$UV_BIN|g" \
    -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
    "$TEMPLATE" > "$PLIST_DEST"

# Reload: unload an existing instance (ignore "not loaded" errors), then load.
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load -w "$PLIST_DEST"

echo "Installed $LABEL"
echo "  plist:  $PLIST_DEST"
echo "  runs:   $UV_BIN run --directory $REPO_ROOT fitness brief"
echo "  when:   daily 06:30 (catch-up at next wake if asleep)"
echo "  logs:   $REPO_ROOT/logs/brief.launchd.{out,err}.log"
echo
echo "Run it once now to verify:  launchctl start $LABEL"
echo "Uninstall:                  ./ops/uninstall-launchd.sh"
