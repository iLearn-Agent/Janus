#!/bin/sh
set -eu

copy_secret() {
  source_path="$1"
  target_path="/tmp/$(basename "$source_path")"
  cp "$source_path" "$target_path"
  chown postgres:postgres "$target_path"
  chmod 0600 "$target_path"
  printf '%s' "$target_path"
}

export POSTGRES_PASSWORD_FILE="$(copy_secret "$POSTGRES_PASSWORD_FILE")"
export JANUS_POSTGRES_API_PASSWORD_FILE="$(copy_secret "$JANUS_POSTGRES_API_PASSWORD_FILE")"
export JANUS_POSTGRES_WORKER_PASSWORD_FILE="$(copy_secret "$JANUS_POSTGRES_WORKER_PASSWORD_FILE")"
export JANUS_POSTGRES_MIGRATOR_PASSWORD_FILE="$(copy_secret "$JANUS_POSTGRES_MIGRATOR_PASSWORD_FILE")"

exec /usr/local/bin/docker-entrypoint.sh "$@"
