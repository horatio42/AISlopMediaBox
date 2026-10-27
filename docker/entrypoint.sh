#!/bin/sh
# AISlopMediaBox entrypoint: fix volume permissions, optionally seed demo slop, drop privileges.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
MEDIA_DIR="${MEDIA_DIR:-$DATA_DIR/media}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
SEED_DEMO="${SEED_DEMO:-1}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$DATA_DIR/media" "$DATA_DIR/cache" "$DATA_DIR/cache/images" "$DATA_DIR/cache/transcode" "$DATA_DIR/cache/temp" "$DATA_DIR/cache/logs"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
  exec gosu "$PUID:$PGID" "$0" "$@"
fi

mkdir -p "$DATA_DIR" "$DATA_DIR/media" "$DATA_DIR/cache/images" "$DATA_DIR/cache/transcode" "$DATA_DIR/cache/temp" "$DATA_DIR/cache/logs"

# First boot: generate the demo library (local ffmpeg only, no network) so the box is instantly usable.
if [ "$SEED_DEMO" = "1" ] && [ ! -f "$DATA_DIR/aislop.db" ]; then
  echo "[slop] first boot: generating demo media (this takes a minute, like all good slop)"
  node scripts/demo-content.mjs || echo "[slop] demo generation failed; starting empty"
fi

exec "$@"
