# Changelog

Notable changes to the TeeMail dashboard. The project has no version tags; entries are grouped by period from `git log`.

## Unreleased – membership contract v2 (October 2026)

### Fixed

- `BOOKING_LINK_SECRET` is read with surrounding whitespace stripped (manage-booking and membership links), as the core API reads it: a trailing space or newline in one service's settings made invitation links the core API refused as "not valid". The `JWT_SECRET` fallback for manage links is unchanged.
- Membership emails no longer fall back to `REPLY_TO_EMAIL`/`FROM_EMAIL` (the booking desk's address) for their text, footer or Reply-To: they use the club's contact email, else `MEMBERSHIP_CONTACT_EMAIL`, else `memberships@club.teemail.io`.

### Added

- Boot log line `LINK SECRET: set (fingerprint xxxxxxxx)` / `LINK SECRET: not set`, the same as the core API's, to compare the two services' secrets without revealing them.
- Migration `0009_membership_applicant_details.sql`: `membership_applications.postcode`, `other_clubs`, `cdh_number`. Shown in the application drawer's "Applicant details" block (address with postcode), in the API and the CSV export (which also gains the address); the waitlist table shows phone, postcode and home club; the demo seed fills them.
- `MEMBERSHIP_CONTACT_EMAIL` (`.env.example`, `render.yaml`).
- Membership page: the configuration note names the missing link setting and explains how to spot a `BOOKING_LINK_SECRET` mismatch; invitations refused for a missing setting say which one.

## Unreleased – membership module (October 2026)

### Added

- **Membership**: an on/off switch for membership applications (administrators only, recorded with who changed it). On, an enquiry to the membership address gets the club's categories and a signed apply link from the core API; off, a signed waitlist link.
- Migration `0008_membership.sql`: `club_settings`, `membership_categories`, `membership_applications`, `membership_events`.
- `/api/membership`: settings, categories (admin writes; soft delete when in use), application list/detail/CSV export, review transitions with applicant emails (`membership_under_review`, `_approved`, `_declined`, `_welcome`), staff notes, waitlist invitations (`membership_invite`, only while open), KPI summary. Club-scoped throughout.
- Membership page: the switch with what guests receive in each state, KPI row, Applications / Waitlist / Categories tabs (email wording is handled outside the dashboard), and an application drawer whose actions each state the email the applicant will receive.
- Inbox and conversation labels for membership enquiries and email kinds.
- `db/seeds/seed_membership_demo.sql` (also run by `npm run seed`; `--membership` for only that); `MEMBERSHIP_FORM_BASE_URL`.

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
- Sign-in spends one bcrypt comparison on unknown, deactivated and password-less accounts, so timing does not reveal which accounts exist.
- Tour operator portal sessions are rows (`operator_portal_sessions`, migration 0006): sign-out revokes them and a copied cookie stops working; a new sign-in request retires the address's unused links.
- Stripe webhook log and payment-sync results are filtered to the caller's club.
- `APP_URL` missing in production is logged as an error at boot; only a configured `APP_URL` is trusted by the CSRF origin check.
- Sentry events and breadcrumbs are scrubbed (no query strings, cookies, headers, bodies or user; addresses masked).
- TLS required for every non-local database host; certificate verification with `PGSSLROOTCERT`, `sslmode=verify-full` or `DATABASE_SSL_VERIFY=true`.
- Operator and waitlist deletes are administrator-only (hidden from staff in the SPA).
- `.xlsx` exports defuse formula-like strings too.
- Booking references the dashboard issues use the core API's format and the CSPRNG (`BOOKING_REF_PREFIX-YYYYMMDD-XXXXXXXXXX`), so guest replies quoting them are linked.

### Quality

- Versioned schema migrations (`db/migrations/0001`–`0007`) applied before the server listens, with checksums, an advisory lock and one transaction per file; `npm run migrate`, `npm run migrate:status`. The old `migration_*.sql` files, runtime schema probes and the `npm run check` preflight are retired; every route assumes the migrated schema.
- Static column lists instead of runtime column detection.
- Migrations check the catalog before every DDL statement (`pg_temp` guard helpers): no-ops on an existing schema need no table ownership; CHECK constraints are added `NOT VALID` then validated, and unique indexes that existing duplicates block are skipped with a warning, never failing the deploy or deleting data.
- Migration 0007: `email_messages.message_id` with a unique inbound index, and an index for rows the core API is still processing; the Inbox labels `queued`/`processing` rows and never counts them as needing a person.
- Every entry point loads the repository-root `.env` (`server/src/env.js`), so `npm run dev` needs no extra setup; `.env.example` defaults to `NODE_ENV=development`.
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
