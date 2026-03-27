#!/bin/sh
# Test helper for CliRuntime tests.
# Usage: test-cmd.sh <mode> [extra-args-ignored...]
# Modes:
#   echo-stdin  - reads stdin and writes it to stdout
#   stderr      - writes "err" to stderr
#   fail        - exits with code 1
#   hang        - sleeps for 60s (for timeout tests)
mode="$1"
shift

case "$mode" in
  echo-stdin) cat ;;
  stderr)     echo err >&2 ;;
  fail)       exit 1 ;;
  hang)       sleep 60 ;;
  *)          echo "unknown mode: $mode" >&2; exit 2 ;;
esac
