#!/bin/sh
# "serve" starts the HTTP server; anything else goes to the CLI.
# exec, so Node is PID 1 and receives docker stop's SIGTERM directly.
if [ "$1" = "serve" ]; then
  exec node /app/dist/server/main.js
fi
exec node /app/dist/cli/main.js "$@"
