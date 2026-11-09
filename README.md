# Curry Partner

It’s not homely food. It’s home food.

Curry Partner connects approved home cooks with local curry-point stalls. Administrators publish the next day’s menu, homemakers commit to what they can cook, and Curry Partner staff record collection, inspection, stall stock, sales, and weekly payouts. Collection-agent and selling-agent apps are not part of this launch.

The repository started as a title-only README. This project adds a shared API, a Postgres database, an admin web dashboard, and the homemaker Android app.

## Stack

| Piece | Choice |
| --- | --- |
| API | Node.js, TypeScript, Fastify, Zod, Prisma |
| Database | PostgreSQL 16, decimal money and weights, row-level security |
| Admin | Vite, React, responsive web |
| Homemaker | Expo / React Native (Android, plus Expo web for local checks) |
| Passwords | Argon2id hashes. Temporary passwords are shown once and never logged. |

Both clients call the same HTTP API. Hiding a button is not the security boundary: every protected route checks the session, role, and account state on the server, and Postgres policies constrain the `curry_app` database role.

## Roles

- **Admin** reviews homemakers, publishes menus, and records operations and money.
- **Homemaker** can request access without receiving it. After approval they sign in, must replace the temporary password, and then see only their own area, commitments, wallet, and alerts.

## Run it locally

PostgreSQL 16 is required. Docker Compose is included for machines that have Docker; this environment can also use a locally installed cluster.

```bash
cp .env.example apps/api/.env
# Put real local passwords in apps/api/.env, then:
#   export CURRY_APP_PASSWORD=... CURRY_OWNER_PASSWORD=...
pnpm install
pnpm db:setup
pnpm dev:api
pnpm dev:admin
pnpm --filter @curry/mobile web
```

- API: `http://127.0.0.1:4000`
- Admin: `http://127.0.0.1:5173` (proxies `/api` so the session cookie stays on the admin origin)
- Homemaker web preview: Expo’s URL, usually `http://127.0.0.1:8081`

`pnpm db:setup` creates the `curry_owner` and `curry_app` roles, applies migrations, applies `apps/api/prisma/security.sql`, and loads demo fixtures. The seed refuses to run when `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true`.

Android emulator API host is `http://10.0.2.2:4000`. Set `EXPO_PUBLIC_API_URL` before starting Expo. A device build uses Expo (`pnpm --filter @curry/mobile android` with Android Studio). Push notifications are not wired; alerts stay in the app even if a push would have failed.

### Demo fixtures

These accounts exist only after `pnpm db:seed`. They are prefixed `DEMO` in the product and are not production records.

| Who | Phone | Password | Notes |
| --- | --- | --- | --- |
| Admin | +919800000001 | DemoAdmin-2026 | Owner dashboard |
| Homemaker | +919800000002 | DemoHome-2026 | Approved, T. Nagar |
| First login | +919800000003 | DemoTemp-2026 | Must set a new password |
| Applicant | +919800000004 | none | Pending request `CP-DEMO0001` |

The demo menu for tomorrow keeps its cutoff 36 hours ahead so it can be reviewed after the normal 9:00 PM local cutoff.

## Checks

```bash
pnpm test
pnpm --filter @curry/admin build
pnpm --filter @curry/mobile typecheck
```

The API tests cover onboarding without access, forced password change, area and quantity limits, cutoff, illegal status changes, inspection credit math (`1.005 kg × ₹10.00 = ₹10.05`), dispute holds, stock that cannot go negative, idempotent sales and payouts, and row-level security with no session actor.

## What the server enforces

- Onboarding creates a review record only. Approval creates the homemaker, stores an Argon2id hash, and returns a temporary password a single time.
- Menus are published for a service area. The default publish deadline is 17:00 local time the day before. Publishing later requires an override reason. Homemakers only receive published menus for their area.
- Defaults are 2 curries per homemaker per day and 2 kg per curry. Changes apply to new commitments. Existing menus keep the cutoff stored when they were published.
- Commitment quantities and preparation status changes are validated on the server, including the allowed transition. A homemaker cannot mark an item collected.
- Wallet credits use the inspected and accepted quantity times the rate captured on the commitment, rounded half-up to paise. Failed or disputed inspections are not payable. A dispute writes an offsetting ledger reversal. Ledger rows cannot be updated or deleted.
- Stall stock is allocated from accepted lots. Sales, waste, returns, and adjustments run in a transaction, require a reason, and cannot take available kilograms below zero. Repeating an `Idempotency-Key` does not apply the movement twice.
- Weekly payout batches group unpaid accepted credits. Marking a batch paid writes one payout ledger row per credit and is safe to retry with the same key.

## Security notes

- Runtime queries use `curry_app`, which is not a superuser and does not own the tables. Policies read `app.user_id` and `app.role`, which the API sets inside each transaction. With no actor set, policies return no rows.
- `curry_owner` is only for migrations and the demo seed. It bypasses row-level security. Do not use it as `DATABASE_URL` for the API.
- A stolen `curry_app` password can still set those session variables. Keep that password on the server. Authorization in the API remains mandatory.
- Some inserts (onboarding, audit) avoid `RETURNING` so a role that may write a row is not also required to read every row.
- Login and onboarding routes are rate limited. Request logs redact passwords, cookies, and tokens.
- The API refuses to boot in production when the database URL or token secret still contains a placeholder, or when cookies are not marked secure.
- Do not commit `apps/api/.env`.

## Check both apps on Vercel

One Vercel project serves both web apps and the API on the same address.

- Admin dashboard: `https://<your-project>.vercel.app`
- Homemaker app: `https://<your-project>.vercel.app/cook`
- API: `https://<your-project>.vercel.app/api`

The admin sign-in page links to the homemaker app. With `ALLOW_DEMO_SEED=true`, both screens show the demo phones and passwords.

1. Create a hosted Postgres 16 database (Neon and Supabase work). Copy its connection string.
2. In Vercel, import this repository. Leave the root directory as the repository root. Framework preset is Other. The repo `vercel.json` sets the build.
3. Set these environment variables for Production and Preview:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | The hosted Postgres URL. Add `?connection_limit=1` if the host does not pool connections. |
| `MIGRATION_DATABASE_URL` | The same URL for a first check. Use a separate owner role when you split runtime and migrations. |
| `ACCESS_TOKEN_SECRET` | A random string of at least 32 characters. Do not reuse a local placeholder. |
| `COOKIE_SECURE` | `true` |
| `ENABLE_SCHEDULER` | `false` |
| `ALLOW_DEMO_SEED` | `true` while you are clicking through the demo. Remove it before real homemakers use the site. |
| `CORS_ORIGINS` | The Vercel URL, for example `https://<your-project>.vercel.app` |

4. Deploy. The build applies migrations, row-level security, and, when allowed, the DEMO seed.
5. Open the site root for the admin dashboard and `/cook` for the homemaker app.

A single database login is enough for this check. The build skips the `curry_app` grants when that role does not exist, and a login that owns the tables bypasses row-level security. The API still checks the signed-in role. Before a real launch, create `curry_app` and `curry_owner` on the host and point `DATABASE_URL` at `curry_app`.

## Deployment

The Vercel section above is the web check. The steps below are for a separate API host.

1. Provision PostgreSQL 16.
2. Create `curry_owner` and `curry_app` with strong passwords. Point `MIGRATION_DATABASE_URL` at the owner and `DATABASE_URL` at `curry_app`.
3. Set `ACCESS_TOKEN_SECRET` (32+ random characters), `NODE_ENV=production`, `COOKIE_SECURE=true`, and the real admin-site origins in `CORS_ORIGINS`.
4. Run `pnpm --filter @curry/api db:migrate` and `pnpm --filter @curry/api db:security`.
5. Create the first admin with a one-off script that hashes a password. Leave `ALLOW_DEMO_SEED` unset so the demo fixtures are not loaded.
6. Serve the API over HTTPS. Build the admin with `pnpm --filter @curry/admin build` and host it behind the same site as `/api`, or keep the cookie origin aligned with `CORS_ORIGINS`.
7. Build the Android app with Expo using the production `EXPO_PUBLIC_API_URL`.

Money movement and payout completion should be run as a single API process or behind a transaction-safe database. The in-process cutoff reminder is optional (`ENABLE_SCHEDULER=false` when an external scheduler will call the same notification path later).

## Layout

```text
apps/api        Fastify API, Prisma schema, security SQL, tests
apps/admin      Admin dashboard
apps/mobile     Homemaker Android app
scripts         Database role setup and security apply
```
