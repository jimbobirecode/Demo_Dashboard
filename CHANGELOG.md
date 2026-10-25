# Changelog

Notable changes to the TeeMail dashboard. The project has no version tags; entries are grouped by period from `git log`.

## Unreleased – the lifecycle emails (October 2026)

### Added

- **All sixteen lifecycle emails are written**, in `lib/lifecycle-emails.js`, and sent in the club's own branding through the same path the payment link and receipt already use: a club's SendGrid template where one is configured, the built-in email otherwise. The ladder previously did nothing until somebody had built sixteen templates; a club that switches it on today now starts sending today, with nothing to configure.
- Three rules the copy keeps. It never threatens what the club has not switched on — the warnings and the cancellation only exist in the modes that can stop a booking. Every chasing email carries the payment link, because one that says a booking is at risk and offers no way to pay is a complaint rather than a reminder. And it calls the money what it is: a trade account owing a percentage up front is asked for a *deposit*, a visitor owing all of it is asked for a *payment* — being asked for "a deposit of €1,000" on a €1,000 round is how somebody pays twice.
- Every lifecycle email is written onto the booking's own conversation as well as the ledger, so the drawer shows what the guest was actually told, in with everything else they have been sent.
- `sendgrid-templates/booking-lifecycle.html`, optional, for a club that wants its own layout. It lists every merge field, including `headline`, `button_url` and `button_label`, which carry our copy into a club's design for anybody who wants the words but not the layout.

### Changed

- `emailShell` moved from `payment-link-domain.js` to `email-layout.js` and is exported. The lifecycle emails need the same shell, and two copies of a button's inline CSS is how a club ends up with two subtly different buttons.
- A rung is now "ready" when it has anything to send, which is all of them. The Booking Lifecycle page says so, marks any rung using the club's own wording, and treats a rung with nothing to send as something to report rather than something to configure — it can only mean a rung was added to the ladder without copy.

## Unreleased – the lifecycle settings, rewritten to be read (October 2026)

### Changed

- **The settings screen asks one question instead of four.** It offered four switches that nested and a grid of numbered boxes, which was honest about how the thing is built and did not match the question anybody arrives with. It now asks *how far should this go?* and offers five answers, each named by what the guest gets: off; show me what you would send but send nothing; send reminders but never cancel; send reminders then stop and ask me (recommended); send reminders then cancel it for me. The four flags are still what the server stores — `modeFor` maps between them, and is tested against every combination — but they are the implementation now rather than the decision. Nothing arrives greyed out waiting for something else to be ticked first.
- **The timings are sentences with their units in them**: "Ask for the deposit within [7] days of the booking", "Give them until day [10] before the booking stops". A labelled box reading "First reminder: 5" does not say five of what, counted from when.
- **"What a guest gets"** draws the whole schedule out as two stories — *If they do not pay* and *If they pay* — and follows the numbers as they are edited. It also follows the choice above it: pick "never cancel" and the final warnings and the ending disappear from the picture, because they would not happen. This is the part that does the explaining; it was previously one line of small grey text at the foot of the page.
- The Booking Lifecycle page says in one line what the club has it set to — "Reminders go out, and unpaid bookings stop here for you" — with one link to change it, in place of a four-step checklist describing the machinery. Its tiles are named for what somebody is looking for ("Unpaid bookings: left for you") rather than for the mechanism ("Rungs ready", "Catch-up limit").
- The per-field **inherited** tags are gone. They explained a distinction between a club's saved value and the server's default that only the implementation cares about, and put fourteen badges on a page that needed fewer things on it, not more. The precedence itself is unchanged.

## Unreleased – the lifecycle as the club's own settings (October 2026)

### Added

- **Settings**, a section of its own in the dashboard, holding the booking lifecycle: the four switches, whether visitors are chased, every day count and the catch-up limit. Per club, saved in `club_settings.lifecycle_settings` (migration `0013`). Reading is open to anyone signed in, saving is an administrator's — everybody on the desk should be able to see why a guest was chased on a Tuesday, and far fewer people should be able to change it.
- The form is built around the three things that are easy to get wrong. The switches **nest**, so one below an unset one is disabled and says what it is waiting for rather than sitting there looking live. Turning **auto-cancel** on asks a second time, because it is the only setting whose first effect a guest reads. And the deposit cadence is written out as a sentence underneath the three numbers as they are edited — "Day 0: payment link · Day 5: reminder · Day 7: window closed · Day 10: cancelled" — so a club sees a sequence rather than three inputs that each look fine alone.
- A field a club has never set is marked **inherited**, because an inherited default presented as a decision is how a club ends up believing it picked a cadence it has never looked at.
- Orderings are refused rather than saved: a reminder after the deadline it reminds about, a final deadline with no room for the 48- and 24-hour notices, final details before the confirmation. Checked against the settings as they would be after the save, not the patch alone, so changing one field is never rejected because of another the club has not touched.

### Changed

- **The lifecycle settings are no longer environment variables.** A club's saved value wins, the environment is what a club that has saved nothing inherits, and the spreadsheet's numbers are the fallback — so an install configured entirely from the environment behaves exactly as it did until somebody edits it in the dashboard. `BOOKING_TRIGGERS_BATCH` and `BOOKING_TRIGGERS_MINUTES` stay the deployment's, being about load rather than policy, and `BOOKING_TRIGGERS=off` switches the feature off for a deployment whatever any club has saved.
- The runner is per club: each club's bookings are walked against that club's own settings and its own ladder, and a club with the ladder switched off is not walked at all. The preview and run endpoints are scoped to the signed-in club, which they were not before.
- The scheduler starts regardless and asks the clubs on each tick whether anything should happen — one indexed query when nobody is interested. A club that switches the ladder on cannot be made to wait for the next deploy. Its single-flight guard is now per club, so a tick that runs several clubs no longer hands the second one the first one's result.
- The Booking Lifecycle page's set-up card links to Settings instead of naming environment variables.

### Fixed

- Checkboxes in the new settings form stretched the full width of their row, dropping each label onto its own line: the stylesheet gives every `input` `width: 100%`, which is right for the text fields it was written for. Overridden in the component rather than in the stylesheet, which other screens are laid out against.

## Unreleased – the booking lifecycle ladder (October 2026)

### Added

- **The booking lifecycle from the club's spreadsheet**, as a branching lifecycle rather than a mailing schedule. A booking is taken, a payment link goes out, and what happens next depends on whether the money arrives and when: paid, it climbs a ladder of confirmations to the tee; unpaid, a different one towards cancellation. The payment phase runs from the day the ladder took the booking on — deposit request (day 0), reminders (5, 6), overdue notice as the 7-day window closes (7), rescue warnings (48 and 24 hours before the second deadline), cancellation (10) — and a receipt with the terms for the next stage the moment money arrives. The balance phase (trade only, which is all the sheet writes it for) counts back from the balance deadline: notice ten days out, 48- and 24-hour reminders, then cancellation if still owing or the thank-you that closes the payment phase if paid. The communication phase is the confirmation at 30 days, the final details at 10, and the thank-you 24 hours after the tee time. Every day count is overridable. See [docs/BOOKING_LIFECYCLE.md](docs/BOOKING_LIFECYCLE.md).
- Branching is by condition per rung, so the sheet's "if payment made revert to the if Paid process" needs no jump and no state machine: the unpaid rungs stop matching the moment the money is in and the paid ones start. A booking that pays on day six finds the day-seven warning recorded as `skipped` and the receipt due, with nothing anywhere that knows it reverted.
- The balance deadline is the trade account's own `balance_due_days_before_play` wherever it sets one, and the sheet's 60 days only as the fallback — an email saying the balance is due on the 12th must not sit beside a drawer saying the 2nd. A date on the booking wins over both. `paymentState`'s invoice-terms fallback (play plus 30 days) is deliberately not used: right for billing, a month after the round for a deadline.
- Four guards, which are the parts worth reviewing. A **ledger** (`booking_trigger_sends`, migration `0012`) rather than fifteen more nullable timestamps, whose partial unique index — `WHERE outcome <> 'failed'` — is the no-double-send guarantee, with failures outside it so they retry; the row is written before the send, so a crash leaves a claim that is rewritten as failed, never a second cancellation notice. A **catch-up horizon** (3 days), without which the first run after switching on would email a year of history its own deadlines. **Collapsing** to at most one email per booking per run, the furthest-along rung by date, with the rungs it overtook recorded as `superseded` so an expired warning never arrives a day late — and so a round that has already been played is thanked rather than cancelled over an unpaid deposit. And **three switches, all off by default and nested**: deadlines do nothing until the ladder is on, the schedule nothing until deadlines are, and nothing is cancelled until auto-cancel is, so a club can read a week of dry runs (`POST /api/booking-triggers/preview`) before the ladder sends anything.
- With auto-cancel off — the default — a booking that runs out of road is listed at `GET /api/booking-triggers/held` and nothing is emailed.
- The confirmation and post-play rungs are the existing pre-arrival and post-play campaigns, not a second copy of them: the ladder treats a booking the Guest Emails page has already written to as settled, and stamps the same column when it sends, so neither mechanism can email a guest the other already has.

### Changed

- `bookings` gains `lifecycle_started_at`, the anchor every payment-phase rung is measured from, written once and never moved — not `updated_at`, which moves on every edit, and not `created_at`, which can be months before the club committed to the booking. A booking that already had a payment link sent by hand is anchored on `payment_link_sent_at` instead.

## Unreleased – booked customers posted to another system (October 2026)

### Added

- **Booked customers are POSTed as JSON** to the endpoint `BOOKED_WEBHOOK_URL` names, one customer per request, as each booking reaches `Booked`. The body carries the customer (name, email, phone) and their round (date, tee time, players, course, caddies) and deliberately nothing else: no total, no payment state, no lodging, no special requests and no staff notes. Caddies are included because they are the one request somebody has to turn up for, and are sent three ways — the answer as recorded, the dashboard's classification of it (`Requested`/`Not required`/`Not specified`) and its estimate of how many, from the same functions the Analytics page uses, so one booking never reads as a request on one screen and a refusal on another. Off entirely until both `BOOKED_WEBHOOK_URL` and `BOOKED_WEBHOOK_KEY` are set; the key travels in a header (`x-webhook-key`, or `BOOKED_WEBHOOK_AUTH_HEADER`), and a non-https URL is refused rather than putting a guest's details on the wire in clear. See [docs/BOOKED_CUSTOMER_WEBHOOK.md](docs/BOOKED_CUSTOMER_WEBHOOK.md).
- Delivery is at-least-once rather than best-effort. `bookings.booked_webhook_sent_at` (migration `0011`) is stamped only once the receiver accepts, so a sweep every `BOOKED_WEBHOOK_MINUTES` (default 2, `BOOKED_WEBHOOK_BATCH` at a time) finds every Booked booking that carries no stamp and tries again. That covers a receiver that was down, each of the four paths that reach `Booked` (a user, a Stripe payment, a waitlist conversion, a tee-sheet import) and the core API, which books in its own process where no dashboard code runs. An outage stops that pass of the sweep; a refusal of one booking is logged as an error and the pass carries on. Neither is stamped, so both are retried every pass — a refusal is usually a receiver's own bug, and the booking goes through once that is fixed with nothing to replay by hand. Receivers should key on `bookingRef`: a process killed between the POST and the stamp re-sends that one booking.
- A booking with no email address and no phone number — an imported tee-sheet row is often just a name and a time — is skipped rather than posted as a near-empty record, and picked up by a later sweep if contact details arrive.

## Unreleased – deleting mail, and notes with a user stamp (October 2026)

### Added

- **Delete an email from the mailbox**, recoverably (`DELETE /api/inbox/:id`, `POST /api/inbox/:id/restore`). The email leaves every list, count and conversation — a booking's thread and a membership application's thread included — and a new **Deleted** filter shows them with who deleted them and when, and puts one back. The row itself is kept: a membership application's enquiry, a guest request, a reply's `in_reply_to` and the Message-ID that stops SendGrid delivering the same email twice all point at it. A deleted email accepts nothing but restore (reply, status, link and notes answer 409), and one the core API still has in hand (`routed_to` `queued`/`processing`) cannot be deleted at all — it re-processes those, and would answer a guest whose email the club had just deleted.
- **Notes on an email** (`POST /api/inbox/:id/notes`), each stamped with the username that wrote it and the time, shown under the conversation. For the team only — never sent to the guest, never editable afterwards. New table `email_notes` (migration `0010`), one row per note.

### Fixed

- A club email in a conversation read `You (alice)` whoever was looking at it, telling every other user they had written alice's reply. It now shows the username as it is, the same for everybody; `bot` and `Stripe` keep reading as "Sent automatically" and "Sent on payment".
- A dismissed email now says when it was closed, not only by whom.

## Unreleased – membership out of the Inbox (October 2026)

### Changed

- The Inbox no longer lists or counts membership correspondence (`routed_to = 'membership'`), under any status including `all`: it is read on the Membership page, beside the application, its timeline and the club's decisions. A membership email that produced no application — membership misconfigured, database unreachable, tables missing — is still routed to `inbox` and does appear, so an enquirer nobody answered is never invisible.
- `GET /api/membership/applications/:id` returns `thread` (the whole conversation with the applicant, by address plus the enquiry itself — they may have given a different address on the form) and `needsReply` (what the core API could not finish: an unanswered reply, an automatic email that did not send). The application drawer shows the conversation and puts `needsReply` at the top of the Enquiry section.
- An Inbox item for a membership enquiry says it was not answered and no application was created, instead of claiming it was answered automatically — only a fault reaches the Inbox now.

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
