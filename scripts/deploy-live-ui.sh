#!/usr/bin/env bash
set -euo pipefail

SOURCE_UI_DIR="/home/wlaim/openclaw/dist/control-ui"
LIVE_UI_DIR="/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist/control-ui"
LIVE_UI_PARENT="$(dirname "$LIVE_UI_DIR")"
BACKUP_ROOT="${LIVE_UI_PARENT}/control-ui-backups"
TIMESTAMP="$(date -u +"%Y%m%d-%H%M%S")"
BACKUP_PATH="${BACKUP_ROOT}/control-ui-${TIMESTAMP}"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ ! -d "$SOURCE_UI_DIR" ]]; then
  fail "Source UI directory does not exist: $SOURCE_UI_DIR"
fi

if [[ ! -d "$LIVE_UI_PARENT" ]]; then
  fail "Live UI parent directory does not exist: $LIVE_UI_PARENT"
fi

if [[ ! -d "$LIVE_UI_DIR" ]]; then
  fail "Live UI directory does not exist: $LIVE_UI_DIR"
fi

log "Creating backup: $BACKUP_PATH"
sudo mkdir -p "$BACKUP_ROOT"
sudo cp -a "$LIVE_UI_DIR" "$BACKUP_PATH"

log "Replacing live UI from: $SOURCE_UI_DIR"
sudo rm -rf "$LIVE_UI_DIR"
sudo cp -a "$SOURCE_UI_DIR" "$LIVE_UI_DIR"

log "Deploy complete."
log "Backup path: $BACKUP_PATH"
