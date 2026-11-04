# Dashboard HTTP API

Every route served by the Express app (`server/src/app.js`, routers in `server/src/routes/`). The core API's routes are documented in its own [docs/API.md](https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/API.md).

## Conventions

| Item | Rule | Code |
|---|---|---|
| Format | JSON in and out (`express.json`, 200 kB limit; 12 MB on `/api/imports`). Errors are `{ "error": "…" }` | `app.js` |
| CSRF | Every **non-GET/HEAD/OPTIONS** request under `/api` must carry `X-Requested-With: teemail`, and an `Origin` header, if present, must be this host or `APP_URL`'s origin (plus `http://localhost:5173` outside production). Otherwise **403**. Exempt: `/api/stripe/webhook` | `lib/request-guard.js` `csrfProtection` |
| Auth levels | **Public** – none. **Staff** – `teemail_session` cookie (`requireAuth`). **Admin** – staff session with `role = 'admin'` (`requireAdmin`). **Portal** – `teemail_operator` cookie (`requireOperator`). **Signed link** – HMAC token in the request. **Stripe** – `Stripe-Signature` header | `auth.js`, `routes/portal.js`, `lib/change-request-domain.js`, `lib/stripe.js` |
| Club scoping | Every staff query is filtered by the signed-in account's `customer_id` (re-read from the database on each request); an id from another club answers 404 | all staff routers |
| Forced password change | A staff session whose account has `must_change_password` gets **403** `{ mustChangePassword: true }` everywhere except `/api/auth/me`, `/api/auth/change-password`, `/api/auth/logout` | `lib/session-domain.js` |
| Session errors | No/invalid cookie → 401 `Not authenticated` / `Session expired`; revoked, deactivated or deleted account → 401 and the cookie is cleared | `auth.js` `requireAuth` |
| Rate limits | In-memory, per process (see [SECURITY.md](SECURITY.md#rate-limits-and-throttles)). 429 responses carry `Retry-After` on sign-in | `lib/throttle.js` |
| Unknown `/api/*` | 404 `{ "error": "Not found" }`. Other paths serve the SPA (`web/dist/index.html`) when built | `app.js` |
| Server errors | 500 `Internal server error` (detail only in the log); body too large → 413; unparseable JSON → 400 | `app.js` |

## Health and webhook (`app.js`, `routes/stripe-webhook.js`)

| Method | Path | Auth | CSRF | Purpose / responses |
|---|---|---|---|---|
| GET | `/api/health` | Public | – | `SELECT 1`. 200 `{ok:true, database:"connected"}`; 503 `{ok:false, status:"degraded"}` (reason only in the log). Render health check |
| GET | `/api/stripe/webhook` | Public | – | 200 `{ok:true}`; lets an operator check the URL in a browser. Reveals nothing about configuration |
| POST | `/api/stripe/webhook` | Stripe signature (`STRIPE_WEBHOOK_SECRET`, 300 s tolerance, raw body ≤ 1 MB) | Exempt | Records a completed payment (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `payment_intent.succeeded`) and emails the receipt. 503 if the secret is unset or the database write fails (Stripe retries); 400 on a bad signature or non-JSON; 200 `{received, result, receipt}` otherwise (also for ignored event types) |

## `/api/auth` (`routes/auth.js`)

| Method | Path | Auth | Limits | Purpose / responses |
|---|---|---|---|---|
| POST | `/login` | Public | Failures: 5/15 min per account, 20/15 min per IP → 429 | Body `{email\|username, password}`. 200 `{user, mustChangePassword}` + session cookie; 401 same message for unknown account or wrong password; 400 if fields missing |
| POST | `/change-password` | Staff (allowed during forced change) | 5 wrong current passwords / 15 min per account → 429 | Body `{currentPassword, newPassword}` (current not required on the forced first change). Min 8 chars. Bumps `session_version` (signs out every other session) and re-issues this one |
| GET | `/me` | Staff (allowed during forced change) | – | Current account (`id, username, fullName, customerId, clubName, role`) and `mustChangePassword` |
| POST | `/logout` | Public (reads cookie if present) | – | Clears the cookie and bumps `session_version`: **signs the account out everywhere** |
| GET | `/reset-config` | Public | – | Whether reset email is configured (`available`, `missing`); never the API key |
| POST | `/forgot-password` | Public | 5/15 min per identifier, 20/15 min per IP (silently dropped) | Body `{username}` (username or email). 400 if empty, otherwise always 200 with the same neutral message; emails a reset link when the account exists, is active and has an address |
| POST | `/reset-password/check` | Token in body | – | Body `{token}`. 200 `{email (masked), username, purpose, fullName, clubName}` or 400 (invalid/used/expired/inactive) |
| POST | `/reset-password` | Token in body | 20/15 min per IP → 429 | Body `{token, newPassword, confirmPassword}`. Sets the password, burns all of the user's links, bumps `session_version`, signs nobody in |

## `/api/users` (`routes/users.js`) — all **Admin**, scoped to the admin's club

| Method | Path | Purpose / responses |
|---|---|---|
| GET | `/config` | Whether invitations can be sent (`canInvite`, `missing`, `linkBase`, TTL) |
| GET | `/` | Accounts of this club (no hashes) |
| POST | `/` | Create `{username, email, fullName, role}` with **no password**; emails a 7-day invitation link. 409 on a duplicate username/email |
| POST | `/:id/invite` | Re-send the invitation (supersedes outstanding links). 409 if inactive |
| PATCH | `/:id` | Update name/email/role/active. Refuses self-demotion/self-deactivation and removing the last active admin (409). Role or deactivation changes revoke the account's sessions |
| DELETE | `/:id` | Delete the account (cascade deletes its links). Same last-admin/self guards |

## `/api/bookings` (`routes/bookings.js`) — **Staff**

| Method | Path | Auth | Purpose / responses |
|---|---|---|---|
| GET | `/` | Staff | All bookings of the club with trade account and payment state, operators, payment statuses. First runs a Stripe sync if the last one is older than 10 s (bounded to 8 s). Each booking's `payment` carries `terms` (whose credit terms produced its figures: `{source, operatorName, summary, depositPercent, paymentTermsDays, depositDueDaysBeforePlay, balanceDueDaysBeforePlay}`) and `stages` — see below |
| PATCH | `/:bookingId/payment` | Staff | `{paymentStatus, amountPaid, invoiceNumber, invoicedAt, depositDueDate, balanceDueDate}` (any subset). Validated; `Paid`/`Deposit paid` starts the pre-play clock |
| PATCH | `/:bookingId/status` | Staff | `{status}` ∈ `Inquiry, Requested, Booked, Rejected, Cancelled` (+ legacy `Pending`, `Confirmed`, normalised) |
| PATCH | `/:bookingId/note` | Staff | `{note}` (string) |
| PATCH | `/:bookingId/tee-time` | Staff | `{teeTime}` (non-empty string) |
| DELETE | `/:bookingId` | **Admin** | Permanent delete |
| POST | `/fix-tee-times` | Staff | Backfills missing `tee_time` from the booking note |
| GET | `/export` | Staff | `?format=csv\|xlsx&statuses=&from=&to=`. Includes guest PII and finance columns. CSV cells are formula-defused (`lib/csv.js`) |

## `/api/analytics` (`routes/analytics.js`) — **Staff**

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | `?from=&to=&granularity=` — every report section, computed by `lib/analytics-domain.js` over the club's bookings, waitlist and operators |

## `/api/changes` (`routes/changes.js`) — guest manage-booking and staff approval

| Method | Path | Auth | Limits | Purpose / responses |
|---|---|---|---|---|
| GET | `/booking` | **Signed link** (`?ref=&token=`) | 30/15 min per IP **and** per reference → 429 | Thin view of the booking (date, time, players, courses, status, total, guest name) + allowed actions + pending requests. 404 for any bad link (same message); **410** 30 days after play |
| POST | `/request` | **Signed link** (`{ref, token}` in body) | 10/hour per IP and per reference | `{kind: cancel\|amend, message, requestedDate, requestedTime, requestedPlayers}`. Files a `Pending` request (never changes the booking); 409 if one is already open; emails the guest an acknowledgement |
| GET | `/` | Staff | – | The club's last 200 requests with booking context |
| POST | `/:id/:decision` | Staff | – | `decision` = `approve` or `decline`, body `{note}`. Approving a cancellation sets the booking `Cancelled` (request `Applied`); approving an amendment only marks it `Approved` (`needsEditing: true`). Emails **whoever asked** — the request's own `guest_email` (an operator's, where an operator asked through the portal or by email), falling back to the booking's where a request stored none — and greets them by the booking's name only when they are the lead guest. `{guestEmailed, guestEmail}` report whether it went and to which address. 409 if already resolved |

### Who an address belongs to (`correspondent`)

`{email, kind, name, label, note}`, returned on the Inbox list, on one email, and as `recipient` on a booking's conversation. `kind` is one of:

| kind | when | `label` |
|---|---|---|
| `operator` | a tour operator account owns the address — its `contact_email`, or its own (non-consumer) sending domain | the operator's name |
| `guest` | the address is on bookings under exactly **one** guest name | that name |
| `shared` | the address is on bookings under **several** names — an agency mailbox with no operator account | the address |
| `unknown` | nothing is known about it | the address |

The order matters: an operator account beats anything inferred from a booking, because the club recorded it deliberately. `guest_email` is not reliably a guest's own address — one agency address here is on six bookings under six different golfers — so a name is attached to an address only when that address belongs to one person. A `name` is what may be greeted in a reply; `operator` and `shared` have none, and the composer greets nobody rather than guessing.

### A booking's payment, stage by stage (`payment.stages`)

A trade booking is worked in the order the money is taken, so `paymentState` resolves the operator's credit terms into the stages themselves rather than leaving one combined balance:

| field | meaning |
|---|---|
| `id` / `label` | `deposit` ("Deposit (25%)") or `balance` ("Balance", or "Full amount" where the account takes no deposit) |
| `amount` | what this stage is for, from the account's `deposit_percent` |
| `paid` | what has been paid **towards this stage**: the deposit fills first, the balance takes what is left |
| `outstanding` | `amount − paid`, or 0 on a written-off or refunded booking |
| `dueDate` | resolved from the account's terms, or the booking's own `deposit_due_date` / `balance_due_date` |
| `overridden` | true where that date was set on this booking rather than produced by the terms — flagged so nobody "corrects" it back |
| `settled` / `overdue` / `daysOverdue` / `daysUntilDue` | where this stage stands today |

Stages worth nothing are left out, so a direct booking with no deposit has one. A booking outside the payment ledger (see `PAYMENTS_TRACKED_FROM`) has none, and still names its terms.

## The audit trail — **no endpoint**

Every state-changing request is recorded in `audit_log` by a middleware over the whole API (`lib/audit.js`), so a route added later is covered without anybody instrumenting it. Reads are not logged — this is a record of changes.

**There is deliberately no route that reads, edits or deletes it.** The trail is recorded for the database to answer from: an endpoint that served it would be an endpoint that could be asked to hide something, and the rows name staff and what each of them did. Read it with SQL (Supabase SQL editor, `psql`) — see [SECURITY.md § Audit trail](SECURITY.md#audit-trail) for the queries.

Each row: `club, at, actor, actor_kind, actor_role, action, entity_type, entity_id, outcome, status, method, path, details, ip, user_agent`.

- **`action`** is derived from the path — `PATCH /api/bookings/BOOK-1/payment` → `booking.payment.update` — with the id kept separately in `entity_id`, so every edit of every booking groups under one action. A dozen awkward names are aliased (`payment.link.send`, `auth.login`); anything not aliased still gets its derived name rather than being dropped.
- **`outcome`** is `applied` (2xx/3xx), `refused` (4xx — an attempt is worth keeping, including a 403) or `failed` (5xx).
- **`details`** is the request body with every secret replaced by `[redacted]`, matched on the key containing `password`, `token`, `secret`, `apikey`, `authorization`, `cookie` or `signature` at any depth. Long free text is trimmed to 500 characters: the trail records that an email was sent, not a second copy of it. A preview or an upload stores `{skipped: true}`.
- **Sign-ins** are recorded, including failed ones against an account that exists. An attempt on an address belonging to nobody is attributed to no club — there is none to attribute it to.
- The row is written when the response finishes, so it lands just after the request returns: the trail never holds a reply up, and never fails one.

## `/api/inbox` (`routes/inbox.js`) — **Staff**

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | `?status=open\|replied\|dismissed\|deleted\|all` — inbound emails for review, with counts. Rows the core API is still handling (`routed_to` `queued`/`processing`) are left out of every status and count except `all`, where they are labelled `Queued` / `Being processed`. Membership correspondence (`routed_to = 'membership'`) is left out of **every** status and count, `all` included: it is read on the Membership page with the application. A membership email that produced no application (membership misconfigured, database unreachable) is routed to `inbox` like anything else needing a person, and does appear. A deleted email (`deleted_at`) is listed and counted only under `status=deleted`, never under `all` |
| GET | `/booking/:bookingId` | A booking's whole conversation, and `recipient` — who the next email would go to (same shape as `correspondent`) |
| POST | `/booking/:bookingId/send` | `{subject, body, to}` — email whoever the club has been corresponding with about this booking: the last person to write in, and the booking's own address only when nobody has (a tour operator's booking is answered to the operator, not to the lead guest named on it). `to` is the address the composer showed and is honoured only when it is already part of that conversation (either end of any email on it) or the booking's own; anything else is ignored. Logged in `email_messages` |
| POST | `/preview` | `{body, replyToId}` — render the HTML a reply would send |
| GET | `/:id` | One email, its thread, who it is with and its notes (`{message, thread, booking, correspondent, notes}`; a note is `{id, messageId, note, createdBy, createdAt}`, oldest first). `correspondent` is `{email, kind, name, label, note}` — see below |
| POST | `/:id/reply` | `{subject, body}` — reply to the sender of a received email; closes it in the Inbox |
| POST | `/:id/status` | `{status: dismissed\|open}` |
| POST | `/:id/link` | `{bookingId}` — attach to a booking of this club |
| POST | `/:id/notes` | `{note}` (trimmed, 1–2000 chars) — a note for the team on this email, stamped with the signed-in username and not editable afterwards. Internal: never sent to the guest. Returns the detail payload |
| DELETE | `/:id` | Delete it from the mailbox. **Recoverable**: the row is kept (a membership application, a guest request and a reply's thread point at it — see migration `0010`), stamped `deleted_at`/`deleted_by`, and it leaves every list, count and conversation but `status=deleted`. 409 while the core API still has it (`routed_to` `queued`/`processing`), which it would otherwise re-process and answer |
| POST | `/:id/restore` | Put a deleted email back, with the review status it had |

A deleted email accepts nothing but `restore`: reply, status, link and notes all answer 409 `This email was deleted. Restore it first.`

Outgoing staff emails include the booking's signed manage link when the email is about a booking.

## `/api/waitlist` (`routes/waitlist.js`) — **Staff**

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Entries, demand and conversion figures, suggested conversions |
| POST | `/` | Create an entry (validated) |
| PATCH | `/:waitlistId` | `{status, priority, notes, notificationSent}`; `Converted` is refused here |
| POST | `/:waitlistId/convert` | `{teeTime, date, total}` — creates a `Booked` booking (reference in the core API format, `lib/booking-ref.js`) and links it, in one transaction |
| POST | `/:waitlistId/link` | `{bookingId}` — record that an existing booking was this entry's conversion |
| DELETE | `/:waitlistId` | **Admin**. Delete an unconverted entry (409 for a converted one) |

## `/api/membership` (`routes/membership.js`) — **Staff**: membership enquiries to welcome

The core API answers the enquiry email and hosts the forms (`/membership/apply`, `/membership/waitlist`); these routes are the club's side. Contract: [ARCHITECTURE.md](ARCHITECTURE.md#membership). Every query is scoped to the signed-in club; another club's id answers 404.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/settings` | Staff | `{enabled, settings, updatedAt, updatedBy, canEdit, linksConfigured, missingLinkSettings, emailConfigured, statuses}` — `missingLinkSettings` lists which of `BOOKING_LINK_SECRET` / `MEMBERSHIP_FORM_BASE_URL` is unset or blank. No `club_settings` row reads as `enabled: false` |
| PUT | `/settings` | **Admin** | `{enabled?: boolean, settings?: {intro, next_steps, closed_message, contact_email, committee_name}}` — upserts `club_settings`, records `updated_by`, logs who opened/closed applications. Unknown keys dropped; 400 on bad types, lengths or address |
| GET | `/summary` | Staff | KPI row: `newSubmissions`, `underReview`, `awaitingWelcome` (approved), `waitlist`, `enquiriesThisMonth`, `welcomedThisYear`, `enabled` |
| GET | `/categories` | Staff | Categories (active first) with `applications` (how many point at each) |
| POST | `/categories` | **Admin** | Create (`name` ≤80 required, fees 0–100,000, ages 0–120, min ≤ max). 409 on a duplicate name |
| PUT | `/categories/:id` | **Admin** | Replace a category's fields (same validation) |
| DELETE | `/categories/:id` | **Admin** | Delete; if any application uses it (chosen or recommended) it is retired (`active = false`) instead → `{retired: true}` |
| GET | `/applications?status=&q=` | Staff | Up to 500 applications with `categoryName`, plus `counts` per status. `status` is one status, a comma list or `all`; `q` matches name, email or reference (literal, no wildcards) |
| GET | `/applications.csv?status=&q=` | Staff | The same as CSV (reference, status, kind, name, email, phone, category, date of birth, address, postcode, handicap, CDH number, home club, other clubs, proposer, seconder, dates); every cell through `lib/csv.js` (formulas defused) |
| GET | `/applications/:id` | Staff | `{application, category, recommendedCategories, events, sourceEmail, thread, needsReply, emailConfigured}` — `sourceEmail` is the logged inbound enquiry (`source_message_id`); `thread` is the whole conversation with the applicant (by their address, plus the enquiry itself — they may have given a different address on the form), oldest first, max 100, since membership email is not in the Inbox; `needsReply` is the `review_reason` of the most recent inbound message the core API could not finish (an unanswered reply, an automatic email that did not send), else `null`. An application carries the applicant's details: `firstName`, `lastName`, `email`, `phone`, `dateOfBirth`, `address`, `postcode`, `homeClub`, `otherClubs`, `handicap`, `cdhNumber`, `proposer`, `seconder`, `message` (`''` when not given) |
| PATCH | `/applications/:id/status` | Staff | `{status, note}` — validated transition (409 otherwise; `invited` → 400, use invite). Writes `membership_events` (`status:<new>`), `decided_by/decided_at` (+`decision_note`) on approved/declined, `welcomed_at` on welcomed; then emails the applicant (`membership_under_review`, `_approved`, `_declined`, `_welcome`) and logs it in `email_messages`. `{application, emailed, emailKind, emailNotice}` — the decision stands if the email cannot go |
| POST | `/applications/:id/notes` | Staff | `{note}` (≤2000) — appended to `staff_notes` as `[time user] note`, plus a `note` event |
| POST | `/applications/:id/invite` | Staff | `waitlisted → invited`; only while applications are **on** and links can be signed (`BOOKING_LINK_SECRET` + `MEMBERSHIP_FORM_BASE_URL`, blank counts as unset), else 409 naming what is missing. Emails `membership_invite` with the signed apply link (same reference) |
| POST | `/applications/invite-waitlist` | **Admin** | Invite every waitlisted applicant of the club; `{invited, emailed}` |

Applicant emails name, and take replies at, the membership contact address: `membership_settings.contact_email`, else `MEMBERSHIP_CONTACT_EMAIL`, else `memberships@club.teemail.io` — never `REPLY_TO_EMAIL`/`FROM_EMAIL`. Links are signed with `BOOKING_LINK_SECRET` (whitespace stripped); if the core API refuses them as "not valid", compare the `LINK SECRET` fingerprint both services log at boot.

## `/api/operators` (`routes/operators.js`) — **Staff**

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Every account with exposure and ageing, plus the direct-booking pseudo-account and totals |
| GET | `/:id` | One account with its bookings |
| POST | `/` | Create (validated; consumer email domains refused in `email_domains`) |
| PATCH | `/:id` | Update |
| DELETE | `/:id` | **Admin**. Delete, or **retire** (`active = false`) when bookings are attached |
| GET | `/suggestions/unmatched` | `?threshold=` — business domains seen repeatedly with no account; bookings naming an operator in text |
| POST | `/assign` | `{bookingIds[], operatorId\|null}` — attach/detach bookings; the operator must belong to the club |

## `/api/emails` (`routes/emails.js`) — **Staff**: guest journey campaigns

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Which campaigns can send; Club Vero status (key stripped) |
| GET | `/pending` | `?campaign=pre_arrival\|post_play&scope=due\|all` — who is due |
| POST | `/send` | `{campaign, bookingIds[≤200], dryRun}` — rows re-read by club; asks Club Vero for a survey link first when enabled; stamps each booking so nobody is emailed twice |

## `/api/booking-triggers` (`routes/booking-triggers.js`) — **Staff**: the booking lifecycle ladder

The payment and communication triggers each booking climbs. See [BOOKING_TRIGGERS.md](BOOKING_TRIGGERS.md).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/config` | Staff | The ladder, the deadlines, the three switches, the last pass (key stripped) |
| GET | `/pending` | Staff | `?scope=due\|missed\|all` — what the workflow would do |
| GET | `/history` | Staff | `?limit=≤200` — rungs already climbed, newest first |
| GET | `/bookings/:bookingId` | Staff | One booking's whole ladder |
| POST | `/run` | Staff | `{bookingIds[≤200]\|null, dryRun}` — climb what is due; rows re-read by club; one email per booking per run |
| POST | `/clear` | Staff | `{bookingId, steps[]}` — record rungs as handled without emailing |
| POST | `/sweep` | Admin | Run the scheduled pass now, across every club |

## `/api/imports` (`routes/imports.js`) — **Staff** (12 MB JSON body)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/config` | Staff | Row ceiling (5,000) and the last 20 batches |
| POST | `/preview` | Staff | `{filename, content (base64), dayFirst}` — parse and report; writes nothing. File ≤ 8 MB; `.xlsx` streamed, ≤ 20,000 rows × 100 columns |
| POST | `/commit` | Staff | Same body — insert the fresh rows (`source = 'imported'`), one transaction, ≤ 5,000 rows |
| DELETE | `/:batchId` | **Admin** | Undo a batch: deletes only rows nobody has edited since |

## `/api/payments` (`routes/payments.js`) — **Staff**: Stripe payment links

| Method | Path | Auth | Purpose / responses |
|---|---|---|---|
| GET | `/config` | Staff | What is configured (secrets stripped) and the in-memory log of recent webhook deliveries, **filtered to the caller's club** (entries that belong to no club, such as a refused signature, are shown without a booking reference) |
| POST | `/bookings/:bookingId/link` | Staff | `{amount}` — creates a Stripe Payment Link, emails it to the booking's guest, marks payment `Pending`; deactivates the previous link. 409 if Stripe/SendGrid not configured; 502 if the email fails (the new link is deactivated) |
| POST | `/bookings/:bookingId/receipt` | Staff | Resend the receipt for the last payment |
| POST | `/bookings/:bookingId/check` | Staff | Ask Stripe whether the link was paid; records it if so |
| POST | `/sync` | Staff | Check every pending link now (the run covers every club on the deployment); the answer lists only the caller's club's bookings and counts |
| GET | `/diagnostics` | **Admin** | End-to-end check of keys, mode, `APP_URL`, Stripe webhook endpoints (queried from Stripe), last webhook and last sync |

## `/api/portal` (`routes/portal.js`) — tour operator portal

| Method | Path | Auth | Limits | Purpose / responses |
|---|---|---|---|---|
| POST | `/login` | Public | 5/15 min per address, 20/15 min per IP (silently dropped) | `{email}`. 400 if empty, otherwise always 200 with a neutral message; when the address is an operator's contact or on one of its (non-free-mail) domains, retires that address's unused links and emails a new one-time link valid 30 min |
| POST | `/session` | Token in body | 20/15 min per IP → 429 | `{token}`. Claims the link atomically (single use), checks the operator is active, records a session (`operator_portal_sessions`) and sets the `teemail_operator` cookie (12 h) carrying its id. 400 for any bad link |
| POST | `/logout` | Public (reads the cookie) | – | Revokes the session row and clears the cookie; a copy of the cookie no longer works |
| GET | `/me` | Portal | – | Operator, terms and account summary |
| GET | `/bookings` | Portal | – | Only this operator's bookings, with what each owes |
| GET | `/statement.csv` | Portal | – | The same as CSV (formula-defused) |
| POST | `/bookings/:bookingId/request` | Portal | – | Change/cancel request for one of **their** bookings (404 otherwise); filed `Pending` |
| POST | `/bookings/:bookingId/pay` | Portal | – | Creates a Stripe link for the **server-computed** outstanding balance; returns `{url, amount}`. 409 if payments not configured |
| POST | `/enquiries` | Portal | – | New tee-time request → `email_messages` row in the club's Inbox |

Every portal request checks the session row (`operator_portal_sessions`: not revoked, not expired, same operator and club) and re-reads the operator: signing out, retiring the account or removing the signed-in address/domain ends the session (401).

## SPA routes (not API)

Served by `web/src/App.jsx`: staff pages (`/bookings`, `/analytics`, `/requests`, `/inbox`, `/waitlist`, `/membership`, `/operators`, `/emails`, `/booking-status`, `/settings`, `/import`, `/users` (admin), `/account/password`); public pages (sign-in at any other path), `/forgot-password`, `/reset-password?token=`, `/accept-invite?token=`, `/manage-booking?ref=&token=`; portal `/portal`, `/portal/sign-in?token=`.
