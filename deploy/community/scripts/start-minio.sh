#!/bin/sh
set -eu
export MINIO_ROOT_PASSWORD="$(cat "$MINIO_ROOT_PASSWORD_FILE")"
exec /usr/bin/docker-entrypoint.sh "$@"
