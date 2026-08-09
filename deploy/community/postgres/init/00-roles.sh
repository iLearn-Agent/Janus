#!/bin/sh
set -eu

api_password="$(cat "$JANUS_POSTGRES_API_PASSWORD_FILE")"
worker_password="$(cat "$JANUS_POSTGRES_WORKER_PASSWORD_FILE")"
migrator_password="$(cat "$JANUS_POSTGRES_MIGRATOR_PASSWORD_FILE")"

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=api_password="$api_password" \
  --set=worker_password="$worker_password" \
  --set=migrator_password="$migrator_password" <<'SQL'
CREATE ROLE janus_api NOLOGIN;
CREATE ROLE janus_evolution_worker NOLOGIN;
CREATE ROLE janus_migrator NOLOGIN;
CREATE ROLE janus_api_login LOGIN PASSWORD :'api_password';
CREATE ROLE janus_worker_login LOGIN PASSWORD :'worker_password';
CREATE ROLE janus_migrator_login LOGIN PASSWORD :'migrator_password';
GRANT janus_api TO janus_api_login;
GRANT janus_evolution_worker TO janus_worker_login;
GRANT janus_migrator TO janus_migrator_login;
GRANT CONNECT ON DATABASE janus TO janus_api_login, janus_worker_login, janus_migrator_login;
GRANT USAGE, CREATE ON SCHEMA public TO janus_migrator_login;
SQL
