#!/bin/sh
# AI Edit Studio installer for macOS and Linux. Safe to run again (upgrade/repair).
# Usage: ./install.sh [--data-root /path/to/folder] [--no-claude] [--no-codex] [--dry-run]
set -e
cd "$(dirname "$0")"
echo "AI Edit Studio - installer (your footage stays on this computer)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required: https://nodejs.org (macOS: brew install node)"; exit 1
fi
# The editor needs an FFmpeg that can draw text and captions. On macOS that is Homebrew's "ffmpeg-full"
# (keg-only; the engine finds it); the plain "ffmpeg" formula cannot.
has_text_ffmpeg() {
  for f in /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg /usr/local/opt/ffmpeg-full/bin/ffmpeg "$(command -v ffmpeg 2>/dev/null)"; do
    [ -n "$f" ] && [ -x "$f" ] && "$f" -hide_banner -filters 2>/dev/null | grep -q ' drawtext ' && return 0
  done
  return 1
}
if [ "$(uname)" = "Darwin" ] && ! has_text_ffmpeg && command -v brew >/dev/null 2>&1; then
  printf "AI Edit Studio needs Homebrew's complete FFmpeg (ffmpeg-full). Install it now? [Y/n] "; read -r answer || answer=y
  case "$answer" in n*|N*) ;; *) brew install ffmpeg-full ;; esac
fi
exec node cli.mjs install "$@"
