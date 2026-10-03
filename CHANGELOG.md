# Changelog

Notable changes to the TeeMail dashboard. The project has no version tags; entries are grouped by period from `git log`.

## Unreleased – security and quality hardening (October 2026)

### Security

- Staff sessions re-checked against the database on every request; `session_version` revokes every session of an account on sign-out, password change/reset, role change, deactivation or deletion; role and club taken from the account, not the token.
- Temporary passwords stored as bcrypt hashes (plaintext rows hashed at boot); temp-password sessions held on the change-password screen.
- Sign-in throttled on failures per account and per client IP (429 with `Retry-After`); current-password checks are throttled too.
- Real client IP behind Render (`trust proxy` = 1 hop) for every throttle; client-supplied `X-Forwarded-For` no longer trusted.
- Operator portal sessions end when the operator is retired or the address leaves the account; manage-booking links refused 30 days after play; per-reference throttles on the guest endpoints.
- Security headers via helmet (CSP without inline scripts, HSTS, frame-ancestors none, referrer policy); CSRF check (`X-Requested-With` + `Origin`) on every state-changing API call; 200 kB JSON limit everywhere except imports; `/api/health` no longer describes the database.
- Spreadsheet formulas defused in CSV exports and the operator statement.
- Many more free-mail domains (and provider families) refused for portal domain sign-in.
- Administrators only for booking delete, import undo and payment diagnostics; the webhook GET no longer reports configuration.
- Uploaded workbooks read as a stream with row/column ceilings.
- Dependencies: helmet added, react-router-dom 7, `uuid` override; `npm audit` clean.
- Ad-hoc booking-deletion and debug SQL scripts removed from the repository.

### Quality

- Versioned schema migrations (`db/migrations/0001`–`0005`) applied before the server listens, with checksums, an advisory lock and one transaction per file; `npm run migrate`, `npm run migrate:status`. The old `migration_*.sql` files, runtime schema probes and the `npm run check` preflight are retired; every route assumes the migrated schema.
- Static column lists instead of runtime column detection.
- One small logger (`LOG_FORMAT=json`, `LOG_LEVEL`) with optional Sentry; `.env.example` and `render.yaml` completed.
- HTTP route tests for the security-critical paths against real Postgres; migration runner tests; Vitest for the SPA; coverage floors.
- ESLint (flat config) and Prettier, every finding fixed; dead code removed.
- CI: lint, format, tests with coverage, build, `npm audit`, migrations and seeds on Postgres 16.
- Documentation pack: README, `docs/` (architecture, data model, API, security, data flows, deployment, migrations, operations, testing, audit readiness), contributing guide, licence, changelog.

## September 2026

- JavaScript dashboard (Express + React) replacing the Streamlit one; club-profile branding, first for the Royal Dornoch demo, then TeeMail Golf Club with every name configurable.
- Analytics on Tremor-derived charts; booking request utilisation.
- Pre-arrival and post-play guest emails; Club Vero survey links.
- Tour operator accounts, credit terms and operator reminders; tour operator portal with emailed sign-in, balances, requests and online payment.
- Password reset, sign-in by email address, roles, invitations and the Users page.
- Waitlist conversion tracking and suggested conversions.
- Guest manage-booking links and Guest Requests (staff approval required for every change).
- Stripe payment links, webhook, receipts, pre-play clock and payment sync.
- Inbox and per-booking email conversations; branded emails with an embedded logo.
- Tee-sheet import.
- Supabase Postgres support; Streamsong and Streamlit code removed.

## November – December 2025

- Initial Streamlit dashboard over the core API's `bookings` table: status workflow (Inquiry → Requested → Confirmed → Booked), hotel/lodging fields, booking cards.
- Waitlist, marketing segmentation, customer-journey email system.
- Ad-hoc test-data and deletion scripts (removed in October 2026).
