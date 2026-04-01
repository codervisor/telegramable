#!/bin/sh
# Test helper that simulates a stale session scenario.
# When called with --resume, fails with "No conversation found" error.
# Otherwise succeeds and echoes all args.
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then
    echo "No conversation found with session ID: stale-id" >&2
    exit 1
  fi
done
# Success path: echo all args so tests can verify --session-id was used
echo "$@"
