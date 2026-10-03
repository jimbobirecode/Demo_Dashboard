# TeeMail dashboard

The staff dashboard of **TeeMail**, an email booking assistant for golf clubs. A React single-page app served by an Express API, over the Postgres database it shares with the [TeeMail core API](https://github.com/jimbobirecode/Demo_core_api) (the email bot and guest booking form).

It serves three audiences:

- **Club staff** — bookings, the Inbox of emails the bot held for a person, guest change requests, waitlist, tour operator accounts, payments, guest and operator email campaigns, tee-sheet imports, analytics, and (for administrators) user accounts.
- **Tour operators** — a portal with emailed one-time sign-in: their bookings and balances, change requests, new enquiries, online payment.
- **Guests** — a manage-booking page reached by a signed link, where they ask to change or cancel.

This repository also **owns the database schema** for both services: versioned migrations in [`db/migrations/`](db/migrations), applied automatically before the server listens.

How the two services fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (local)

Requirements: Node **22** (`.node-version`; `engines` allows 20–24), a local Postgres (16 in CI).

```bash
# 1. Node and dependencies
fnm use                         # reads .node-version; or: nvm install 22
npm ci

# 2. Environment
cp .env.example .env            # set DATABASE_URL and JWT_SECRET at least (NODE_ENV=development is the default)

# 3. Database
createdb teemail_dev            # DATABASE_URL=postgresql://localhost/teemail_dev
npm run migrate                 # apply db/migrations
npm run seed                    # optional sample data; prints the demo sign-in

# 4. Run
npm run dev                     # API on :3001 (node --watch) + Vite on :5173 (proxies /api)
# open http://localhost:5173

# Production-style, single origin on :3001
npm run build && npm start
```

Every entry point (`npm run dev`, `npm start`, `npm run migrate`, `npm run seed`) reads the repository-root `.env` (`server/src/env.js`); variables already in the environment win. Without SendGrid, Stripe or Club Vero settings the pages that need them say what is missing and do not send.

## Tests, lint and format

```bash
npm test                        # server unit tests, then web (Vitest)
npm run test:coverage           # server with coverage floors (lines 68%, branches 84%, functions 72%)

# DB integration tests: a throwaway Postgres whose user may CREATE DATABASE
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
npm run test:server

npm run lint                    # ESLint
npm run format:check            # Prettier (npm run format to fix)
```

Never point `TEST_DATABASE_URL` at real data: the tests create, truncate and drop databases on that server. Details: [docs/TESTING.md](docs/TESTING.md).

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | API (`node --watch`) and Vite dev server together |
| `npm run build` | Build the SPA into `web/dist` (served by the API in production) |
| `npm start` | Production server: migrate, then listen on `PORT` (3001) |
| `npm run migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run migrate:status` | List applied and pending migrations; changes nothing |
| `npm run seed` | Sample bookings, tour operators and a demo login (`-- --reset` to rebuild sample rows, `-- --operators` for operators only). Never against production |
| `npm test` | Server tests, then web tests |
| `npm run test:server` / `test:web` | One suite |
| `npm run test:coverage` | Server tests with coverage floors (as CI) |
| `npm run lint` | ESLint over the repository |
| `npm run format` / `format:check` | Prettier write / check |

## Project layout

| Path | Purpose |
|---|---|
| `server/src/index.js` | Boot: `.env` (`env.js`), Sentry, migrations, listen, start-up checks, Stripe payment sync |
| `server/src/app.js` | Express app: helmet/CSP, body limits, CSRF check, routers, SPA fallback, error handler |
| `server/src/auth.js` | Staff sessions (JWT cookie re-checked against the database), sign-in, password hashing |
| `server/src/routes/` | One router per area: `auth`, `users`, `bookings`, `analytics`, `changes` (guest manage-booking + approvals), `inbox`, `waitlist`, `operators`, `emails` (guest campaigns), `reminders` (operator emails), `imports`, `payments`, `stripe-webhook`, `portal` |
| `server/src/lib/` | Rules as pure, unit-tested modules (`*-domain.js`), plus thin clients for SendGrid, Stripe and Club Vero, the logger, throttle, CSV and request guard |
| `server/src/db/migrate.js` | Migration runner (advisory lock, checksums, one transaction per file) |
| `server/test/` | Unit tests; `integration/` needs `TEST_DATABASE_URL` |
| `web/src/` | React SPA: `pages/`, `components/` (incl. Tremor-derived charts on Recharts), `lib/` (API client, palette, formatting) |
| `db/migrations/` | Versioned schema (`NNNN_name.sql`) |
| `db/seeds/` | Sample data SQL (demo profile) |
| `scripts/seed.mjs` | `npm run seed` |
| `sendgrid-templates/` | Ready-to-paste SendGrid template (password reset) |
| `render.yaml` | Render Blueprint |
| `.github/workflows/ci.yml` | Lint, format, tests with coverage, build, `npm audit`, migrations on Postgres 16 |

## Features

- **Bookings**: list and filters over the `Inquiry → Requested → Booked` pipeline (plus `Rejected`, `Cancelled`); edit status, note, tee time; CSV/XLSX export with formula-defused cells; delete (administrators). References the dashboard issues use the core API's format (`TMG-YYYYMMDD-XXXXXXXXXX`, prefix `BOOKING_REF_PREFIX`).
- **Inbox**: emails the core API held for a person, with what the language model understood and a drafted reply; reply (quoting the guest, booking reference in the subject), dismiss, or attach to a booking. Every booking shows its whole email conversation.
- **Guest Requests**: guests (via a signed manage link) and operators ask to amend or cancel; nothing changes until staff approve. Approving a cancellation cancels the booking; approving an amendment leaves the edit to staff. Guests are emailed at each step.
- **Payments**: Stripe Payment Links emailed from the booking drawer; the webhook and a periodic sync record payments once, move `Inquiry`/`Requested` bookings to `Booked`, start the pre-play clock and email a receipt. Manual payment fields and trade credit terms per booking.
- **Tour operators**: accounts with email domains, credit terms (deposit, balance, net days, limit), exposure and ageing; bookings matched by assignment or sending domain (a name in prose is only a suggestion); booking-status and payment-due reminder campaigns; the operator portal.
- **Guest emails**: pre-arrival welcome (after payment by default) and post-play thank-you via SendGrid templates, with dry-run previews and send stamps so nobody is emailed twice; optional Club Vero survey link ([docs/CLUB_VERO_INTEGRATION.md](docs/CLUB_VERO_INTEGRATION.md)).
- **Waitlist**: entries, conversion to a booking in one transaction, suggested conversions made outside the dashboard, conversion reporting.
- **Tee-sheet import**: CSV/XLSX, preview before writing, duplicate detection, undo per batch (administrators); imported rows count as play but never as enquiries in the analytics.
- **Analytics**: KPIs against the previous period, funnel, lead time, party size, course mix, request utilisation, collection and ageing, direct vs trade, accommodation, caddies, journey-email coverage; every chart has a table view.
- **Accounts**: sign-in by email, roles `admin`/`staff`, invitations and self-service reset by one-time emailed links, forced change of legacy temporary passwords.
- **Branding**: defaults to "TeeMail Golf Club"; names, currency, time zone, colours and logo are configurable (`CLUB_*`, `VITE_CLUB_*`, `EMAIL_*` in `.env.example`). Club ids in data (`customer_id`, `club`) are data, not branding: rows carrying the demo profile's `royal_dornoch` id display under the configured brand.

## Demo profile

The sample data and some defaults come from the Royal Dornoch demo (club id `royal_dornoch`, references `RD-DEMO-…`, `db/seeds/seed_royal_dornoch_demo.sql`, Render service name `royal-dornoch-dashboard`, Club Vero partner source `dornoch`). They are a demo profile, not a customer deployment; the core API's equivalent is its `royal_dornoch` club profile.

## Deployment

Render web service from `render.yaml`; build `npm install --include=dev && npm run build`, start `npm start`, health check `/api/health`. Deploy the dashboard **before** the core API (it migrates the shared schema), and set the same `BOOKING_LINK_SECRET` on both. First-deploy checklist, environment variables, rollback and secret rotation: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Product architecture: components, responsibilities, shared contracts, booking lifecycle, topology |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | ERD, table ownership by service, PII columns |
| [docs/API.md](docs/API.md) | Every dashboard HTTP route with auth, CSRF and rate limits |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model, threat model, residual risks |
| [docs/DATA_FLOWS.md](docs/DATA_FLOWS.md) | Personal data inventory, subprocessors, retention, data-subject requests |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Render setup, first-deploy checklist, deploy order, rollback, secret rotation |
| [docs/MIGRATIONS.md](docs/MIGRATIONS.md) | Migration runner and rules |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Monitoring, runbooks, backup and restore, incident response |
| [docs/TESTING.md](docs/TESTING.md) | Tests, coverage floors, CI |
| [docs/AUDIT_READINESS.md](docs/AUDIT_READINESS.md) | Index for auditors across both repositories; open TO CONFIRM items |
| [docs/CLUB_VERO_INTEGRATION.md](docs/CLUB_VERO_INTEGRATION.md) | Club Vero survey integration |
| [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), [.env.example](.env.example) | |

## Licence

Proprietary. See [LICENSE](LICENSE).
