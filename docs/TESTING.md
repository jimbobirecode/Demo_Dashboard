# Testing

## Test types and locations

| Suite | Location | Runner | Needs |
|---|---|---|---|
| Server unit tests | `server/test/*.test.js` (24 files) | `node --test` | Nothing: domain modules are pure functions; `session-auth.test.js` drives `requireAuth` with a stubbed `pool.query` |
| Server DB integration | `server/test/integration/*.test.js` | `node --test` | `TEST_DATABASE_URL` (skipped when unset) |
| Web (SPA) | `web/src/**/*.test.{js,jsx}` (4 files) | Vitest + jsdom + Testing Library (`web/vite.config.js`, setup `web/src/test/setup.js`) | Nothing |

Server unit files by area:

| Area | Files |
|---|---|
| Sessions, auth, CSRF, throttles | `session-domain`, `session-auth`, `request-guard`, `throttle`, `password-reset-domain`, `users-domain` |
| Guests and links | `change-request-domain`, `guest-change-emails`, `portal-domain` |
| Payments | `payment-link-domain` (incl. Stripe signature verification, idempotency rules) |
| Exports and imports | `csv` (formula defusing), `import-domain`, `sheet-reader` (row/column caps) |
| Bookings, analytics, operators, waitlist, email | `bookings-domain`, `analytics-domain`, `operators-domain`, `operator-emails-domain`, `waitlist-domain`, `email-domain`, `email-layout`, `inbox-domain`, `vero-domain`, `currency` |
| Infrastructure | `logger`, `app-loads` (the app module imports and mounts) |

Integration suites:

- `migrate.test.js` — reads migrations in order with stable checksums; CRLF-insensitive checksums; refuses bad names, duplicate versions and files with their own transaction; applies every migration to an empty database then finds nothing to do; re-running the baseline SQL by hand changes nothing; two concurrent runners apply each file once; an edited applied migration is refused; a failing migration rolls back and is not recorded.
- `routes.test.js` — real Express app against a migrated scratch database: sign-in (uniform 401, lockout after 5 failures), `requireAuth` (garbage/foreign signatures, revoked `session_version`, club taken from the account not the token, portal token refused), CSRF header and Origin, club scoping (IDOR) for bookings and users, admin-only routes, operator portal isolation and session end on retirement, manage-booking links (uniform refusal, cross-club token refused, private fields withheld).

Each integration test creates and drops its own databases next to `TEST_DATABASE_URL` (`helpers.js`), so that URL must point at a **disposable server** whose user may `CREATE DATABASE`. Never point it at real data.

## Running

```bash
npm test                     # server (unit + integration if TEST_DATABASE_URL) then web
npm run test:server          # server only
npm run test:web             # Vitest, web only
npm run test:coverage        # server with coverage floors

# With the DB integration suites (local Postgres 16, throwaway):
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
npm run test:coverage
```

At the time of writing: 305 server tests with `TEST_DATABASE_URL` (282 without), 16 web tests, all passing. The route tests in `integration/routes.test.js` use `supertest` against the real app.

Tests set no production secrets and call no external service: SendGrid, Stripe and Club Vero clients take an injected `fetch`, and tests inject a fake.

## Coverage floors

`npm run test:coverage` (`package.json`) runs Node's built-in coverage over `server/src/**` and fails below:

| Metric | Floor | Measured with DB | Measured without DB |
|---|---|---|---|
| Lines | 68% | 75.2% | 70.3% |
| Branches | 84% | 85.3% | 86.3% |
| Functions | 72% | 80.2% | 75.1% |

The floors hold without a database, which is how the CI `test` job runs them; the `database` job runs them again with the integration suites. Route handlers outside the security-critical paths (analytics, campaigns, inbox, waitlist, Stripe webhook handler) have low line coverage; their logic lives in the domain modules, which are covered.

There is no coverage floor for the web suite.

## Lint and format

```bash
npm run lint            # ESLint 9 flat config (eslint.config.js): recommended + react + react-hooks; no console in server/src
npm run format:check    # Prettier 3 (.prettierrc.json) over server, scripts, web/src, web/*.js, eslint.config.js
npm run format          # apply Prettier
```

Markdown, SQL and HTML are excluded from Prettier (`.prettierignore`).

## CI pipeline

`.github/workflows/ci.yml`, on every `push` and `pull_request`, `contents: read` permissions, concurrent runs on the same ref cancelled. Node from `.node-version`, `npm ci` with cache. Four jobs:

| Job | Steps |
|---|---|
| **Lint and format** | `npm run lint`, `npm run format:check` |
| **Unit tests and build** | `npm run test:coverage` (floors enforced; DB suites skip), `npm run test:web`, `npm run build` |
| **Dependency audit** | `npm audit --omit=dev --audit-level=high` |
| **Migrations and DB integration tests** | Postgres 16 service; `npm run migrate` on an empty database; a second `npm run migrate` must print `schema up to date`; `npm run migrate:status`; every `db/seeds/*.sql` applied with `ON_ERROR_STOP`; `npm run test:coverage` with `TEST_DATABASE_URL` |

No production secrets are used in CI. Whether passing CI is enforced as a branch-protection rule: **TO CONFIRM (owner)**.
