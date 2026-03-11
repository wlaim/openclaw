#!/usr/bin/env bash
set -euo pipefail

LIVE_UI_DIR="/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist/control-ui"
LIVE_UI_PARENT="$(dirname "$LIVE_UI_DIR")"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s <backup-path>\n' "$(basename "$0")" >&2
  printf 'Example: %s /home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist/control-ui-backups/control-ui-20260310-120000\n' "$(basename "$0")" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  usage
fi

BACKUP_PATH="$1"

if [[ ! -d "$LIVE_UI_PARENT" ]]; then
  fail "Live UI parent directory does not exist: $LIVE_UI_PARENT"
fi

if [[ ! -d "$BACKUP_PATH" ]]; then
  fail "Backup directory does not exist: $BACKUP_PATH"
fi

if [[ "$BACKUP_PATH" == "/" ]]; then
  fail "Refusing to use / as a backup path"
fi

log "Restoring live UI from backup: $BACKUP_PATH"
sudo rm -rf "$LIVE_UI_DIR"
sudo cp -a "$BACKUP_PATH" "$LIVE_UI_DIR"

log "Rollback complete."
