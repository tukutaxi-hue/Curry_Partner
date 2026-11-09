#!/usr/bin/env bash
# Create local roles and databases. Safe to re-run.
# Uses peer auth (sudo -u postgres) unless PG_SUPER_URL is set.
set -euo pipefail

APP_PASS="${CURRY_APP_PASSWORD:-local-dev-change-me}"
OWNER_PASS="${CURRY_OWNER_PASSWORD:-local-dev-change-me}"

if [[ "$APP_PASS" == *"'"* || "$OWNER_PASS" == *"'"* ]]; then
  echo "Passwords must not contain single quotes." >&2
  exit 1
fi

run_psql() {
  if [[ -n "${PG_SUPER_URL:-}" ]]; then
    psql "$PG_SUPER_URL" -v ON_ERROR_STOP=1 "$@"
  else
    sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
  fi
}

run_psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'curry_owner') THEN
    CREATE ROLE curry_owner LOGIN PASSWORD '${OWNER_PASS}' NOSUPERUSER CREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE curry_owner WITH LOGIN PASSWORD '${OWNER_PASS}' NOSUPERUSER CREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'curry_app') THEN
    CREATE ROLE curry_app LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE curry_app WITH LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
\$\$;
SQL

for db in curry_partner curry_partner_test; do
  exists="$(run_psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${db}'" || true)"
  if [[ "$exists" != "1" ]]; then
    run_psql -c "CREATE DATABASE ${db} OWNER curry_owner"
  fi
  run_psql -d "$db" <<SQL
GRANT CONNECT ON DATABASE ${db} TO curry_app;
GRANT USAGE ON SCHEMA public TO curry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE curry_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO curry_app;
ALTER DEFAULT PRIVILEGES FOR ROLE curry_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO curry_app;
SQL
done

echo "Postgres roles and databases are ready."
