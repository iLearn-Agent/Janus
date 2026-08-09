#!/bin/sh
set -eu

target_directory=/tmp/janus-secrets
mkdir -p "$target_directory"
chmod 0700 "$target_directory"

for source_path in /run/secrets/*; do
  [ -f "$source_path" ] || continue
  target_path="$target_directory/$(basename "$source_path")"
  cp "$source_path" "$target_path"
  chown node:node "$target_path"
  chmod 0600 "$target_path"
done

chown node:node "$target_directory"
export JANUS_SECRET_DIRECTORY="$target_directory"

exec setpriv --reuid="$(id -u node)" --regid="$(id -g node)" --init-groups "$@"
