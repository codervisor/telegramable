#!/bin/sh
node /app/web/server.js &
node /app/cli/dist/cli.js start &
wait
