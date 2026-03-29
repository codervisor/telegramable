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

# Poll until either process exits
while kill -0 "$WEB_PID" 2>/dev/null && kill -0 "$CLI_PID" 2>/dev/null; do
  sleep 1
done

# One process has exited — check which
if ! kill -0 "$WEB_PID" 2>/dev/null; then
  wait "$WEB_PID"
  status=$?
else
  wait "$CLI_PID"
  status=$?
fi

terminate
wait "$WEB_PID" "$CLI_PID" 2>/dev/null
exit "$status"
