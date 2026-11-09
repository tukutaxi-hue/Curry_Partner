#!/usr/bin/env bash
# Builds the admin site, the homemaker web app, and prepares the database.
# Vercel runs this from the repository root after pnpm install.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --filter @curry/api exec prisma generate
pnpm --filter @curry/api exec prisma migrate deploy
role="$(pnpm --filter @curry/api exec tsx ../../scripts/has-app-role.ts | tail -n 1)"
if [ "$role" = "yes" ]; then
  pnpm --filter @curry/api exec prisma db execute --file prisma/security.sql --url "$MIGRATION_DATABASE_URL"
else
  echo "No curry_app role on this database. Skipping row-level grants. The API still checks roles. A table-owning login bypasses row-level security."
fi

if [ "${ALLOW_DEMO_SEED:-}" = "true" ]; then
  echo "Loading labeled DEMO fixtures."
  pnpm --filter @curry/api exec tsx prisma/seed.ts
  export VITE_SHOW_DEMO=true
  export EXPO_PUBLIC_SHOW_DEMO=true
fi

export VITE_HOME_URL=/cook
pnpm --filter @curry/admin build

# Same site as the API, mounted at /cook.
export EXPO_PUBLIC_API_URL=
export EXPO_BASE_URL=/cook
pnpm --filter @curry/mobile exec expo export --platform web

rm -rf vercel-out
mkdir -p vercel-out/cook
cp -R apps/admin/dist/. vercel-out/
cp -R apps/mobile/dist/. vercel-out/cook/
