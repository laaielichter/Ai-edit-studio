#!/bin/sh
# Start the AI Edit Studio editor and open it in the browser (macOS/Linux).
cd "$(dirname "$0")"
URL="http://127.0.0.1:${GAME_TRAILER_STUDIO_PORT:-32146}/"
( sleep 2; if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || echo "Open $URL"; fi ) &
exec node server.mjs
