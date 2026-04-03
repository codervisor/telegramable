#!/bin/bash
# sudo-wrapper.sh — Installed at /usr/local/bin/sudo (higher PATH priority than /usr/bin/sudo).
# Intercepts sudo calls from the Claude Code agent, requests user approval via
# the Telegramable hub (which shows an inline keyboard in Telegram), and only
# executes the real sudo after explicit consent.
#
# Communication: file-based IPC via $TELEGRAMABLE_SUDO_DIR (default /tmp/telegramable-sudo).
# The wrapper writes a .req file, the hub's SudoWatcher picks it up and shows
# Telegram buttons, then writes a .res file with "allow" or "deny".

set -euo pipefail

REAL_SUDO="/usr/bin/sudo"
SUDO_DIR="${TELEGRAMABLE_SUDO_DIR:-/tmp/telegramable-sudo}"
CHANNEL_ID="${TELEGRAMABLE_CHANNEL_ID:-}"
CHAT_ID="${TELEGRAMABLE_CHAT_ID:-}"
TIMEOUT_SECONDS="${TELEGRAMABLE_SUDO_TIMEOUT:-300}"  # 5 minutes

# If not running inside a telegramable session, fall through to real sudo
if [ -z "$CHANNEL_ID" ] || [ -z "$CHAT_ID" ]; then
  exec "$REAL_SUDO" "$@"
fi

# Generate a unique request ID
REQUEST_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s%N)"
REQ_FILE="${SUDO_DIR}/${REQUEST_ID}.req"
RES_FILE="${SUDO_DIR}/${REQUEST_ID}.res"

# Ensure the request directory exists
mkdir -p "$SUDO_DIR"

# Build the command string for display
CMD_STRING="$*"

# Write the request file (atomic: write to temp, then rename)
TEMP_FILE="${SUDO_DIR}/.${REQUEST_ID}.tmp"
cat > "$TEMP_FILE" <<REQEOF
{
  "id": "${REQUEST_ID}",
  "command": $(printf '%s' "$CMD_STRING" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"${CMD_STRING}\""),
  "channelId": "${CHANNEL_ID}",
  "chatId": "${CHAT_ID}",
  "timestamp": $(date +%s000)
}
REQEOF
mv "$TEMP_FILE" "$REQ_FILE"

# Poll for the response file
ELAPSED=0
POLL_INTERVAL_MS=500
while [ "$ELAPSED" -lt "$TIMEOUT_SECONDS" ]; do
  if [ -f "$RES_FILE" ]; then
    DECISION="$(cat "$RES_FILE")"
    rm -f "$REQ_FILE" "$RES_FILE"

    if [ "$DECISION" = "allow" ]; then
      exec "$REAL_SUDO" "$@"
    else
      echo "sudo: permission denied by user via Telegram." >&2
      exit 1
    fi
  fi

  sleep 0.5
  ELAPSED=$((ELAPSED + 1))  # ~0.5s increments, close enough
done

# Timeout — clean up and deny
rm -f "$REQ_FILE" "$RES_FILE"
echo "sudo: permission request timed out (no response within ${TIMEOUT_SECONDS}s)." >&2
exit 1
