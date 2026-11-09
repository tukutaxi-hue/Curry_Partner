#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
set -a
# shellcheck disable=SC1091
source .env
set +a
export DATABASE_URL="$TEST_DATABASE_URL"
export MIGRATION_DATABASE_URL="$TEST_MIGRATION_DATABASE_URL"
pnpm exec prisma migrate deploy
psql "$TEST_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/security.sql >/tmp/curry-security-test.log
