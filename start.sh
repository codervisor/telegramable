#!/bin/sh

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
