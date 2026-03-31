#!/bin/bash

# ── Persist Claude Code sessions across container restarts ──────────────────
# Claude Code stores conversation history and session data in ~/.claude.
# When a Railway Volume (or Docker volume) is mounted at /data, we symlink
# ~/.claude → /data/.claude so that session data survives redeploys.
CLAUDE_HOME="/home/claude/.claude"
PERSIST_DIR="/data/.claude"

if [ -d /data ]; then
  # Ensure the persistent directory exists
  mkdir -p "$PERSIST_DIR"

  # If ~/.claude already exists (from the install step) and is NOT a symlink,
  # seed the persistent dir with any existing content, then replace with symlink.
  if [ -d "$CLAUDE_HOME" ] && [ ! -L "$CLAUDE_HOME" ]; then
    cp -a "$CLAUDE_HOME/." "$PERSIST_DIR/" 2>/dev/null || true
    rm -rf "$CLAUDE_HOME"
  fi

  # Create the symlink (idempotent — remove stale symlink first)
  if [ -L "$CLAUDE_HOME" ]; then
    rm "$CLAUDE_HOME"
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
