#!/bin/bash

# ── Persist Claude Code sessions across container restarts ──────────────────
# Claude Code stores conversation history and session data in ~/.claude.
# When a Railway Volume (or Docker volume) is mounted at /data, we symlink
# ~/.claude → /data/.claude so that session data survives redeploys.
CLAUDE_HOME="${HOME}/.claude"
PERSIST_DIR="/data/.claude"

# Detect whether /data is an actual mount point (volume), not just the empty
# directory created by the Dockerfile.  Try `mountpoint` first, fall back to
# /proc/self/mountinfo for minimal images that lack the util.
data_is_volume() {
  { command -v mountpoint >/dev/null 2>&1 && mountpoint -q /data; } ||
    grep -qE ' /data(/| )' /proc/self/mountinfo 2>/dev/null
}

if data_is_volume; then
  # Ensure the data directory and its contents are writable by the current user.
  # Railway volumes are created as root; the Dockerfile's chown is overridden by the mount.
  if [ ! -w /data ]; then
    echo "[telegramable] Fixing /data permissions for $(whoami)..."
    # Try to fix ownership — works when the container has CAP_CHOWN (common on Railway)
    chown "$(id -u):$(id -g)" /data 2>/dev/null || true
  fi

  # Ensure the persistent directory exists
  mkdir -p "$PERSIST_DIR"

  # If ~/.claude already exists (from the install step) and is NOT a symlink,
  # seed the persistent dir with any existing content, then replace with symlink.
  if [ -e "$CLAUDE_HOME" ] && [ ! -L "$CLAUDE_HOME" ]; then
    cp -a "$CLAUDE_HOME/." "$PERSIST_DIR/" 2>/dev/null || true
    rm -rf "$CLAUDE_HOME"
  fi

  # Create the symlink (idempotent — remove stale entry first)
  if [ -e "$CLAUDE_HOME" ] || [ -L "$CLAUDE_HOME" ]; then
    rm -rf "$CLAUDE_HOME"
  fi
  ln -s "$PERSIST_DIR" "$CLAUDE_HOME"
  echo "[telegramable] Claude Code sessions will persist at $PERSIST_DIR"
else
  echo "[telegramable] No /data volume detected — Claude Code sessions will be ephemeral"
fi

# Start web server
node /app/web/apps/web/server.js &
WEB_PID=$!

# Start CLI process
node /app/cli/dist/cli.js start &
CLI_PID=$!

terminate() {
  kill "$WEB_PID" "$CLI_PID" 2>/dev/null || true
}

on_signal() {
  terminate
  wait "$WEB_PID" "$CLI_PID" 2>/dev/null
  exit 143
}

trap 'on_signal' INT TERM

# Wait for the first process to exit
if ! wait -n "$WEB_PID" "$CLI_PID"; then
  status=$?
  terminate
  wait "$WEB_PID" "$CLI_PID" 2>/dev/null
  exit "$status"
fi

# First process exited successfully; wait for the remaining one
wait "$WEB_PID" "$CLI_PID"
exit $?
