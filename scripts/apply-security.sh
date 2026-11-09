#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
set -a
# shellcheck disable=SC1091
source .env
set +a
psql "${1:-$MIGRATION_DATABASE_URL}" -v ON_ERROR_STOP=1 -f prisma/security.sql >/tmp/curry-security.log
echo "Row-level security policies applied."
