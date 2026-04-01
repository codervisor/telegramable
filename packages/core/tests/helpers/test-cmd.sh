#!/bin/sh
# Test helper for CliRuntime tests.
# Usage: test-cmd.sh <mode> [extra-args...]
# Modes:
#   echo-stdin    - reads stdin and writes it to stdout
#   echo-last-arg - prints the last positional argument (the prompt after "--")
#   stderr        - writes "err" to stderr
#   fail          - exits with code 1
#   hang          - sleeps for 60s (for timeout tests)
mode="$1"
shift

case "$mode" in
  echo-stdin)    cat ;;
  echo-last-arg)
    last=
    for last; do :; done
    printf '%s\n' "$last"
    ;;
  stderr)        echo err >&2 ;;
  fail)          exit 1 ;;
  fail-no-conversation)
    echo "No conversation found with session ID: fake-session-id" >&2
    exit 1
    ;;
  hang)          sleep 60 ;;
  *)             echo "unknown mode: $mode" >&2; exit 2 ;;
esac
