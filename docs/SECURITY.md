# Security model

Scope: the **dashboard** (this repository) in detail, and the **TeeMail product** as a whole in outline. The core API's controls (inbound webhook key, SPF/DKIM, prompt-injection handling, booking form) are documented in its own [docs/SECURITY.md](https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/SECURITY.md); they are summarised here only where the two services meet.

Security contact / vulnerability reporting: **TO CONFIRM (owner)**.

## Product overview

| Service | Entry points | Credential | Detail |
|---|---|---|---|
| Core API | `POST /webhook/inbound` (SendGrid), `/book` + `/submit-booking` (guests), `/api/quote`, `/health` | Shared webhook key; per-booking HMAC link token | [core API SECURITY.md](https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/SECURITY.md) |
| Dashboard | Staff SPA + `/api/*` | JWT session cookie, re-validated against the database per request | Below |
| Dashboard | Tour operator portal `/api/portal/*` | Emailed one-time link → separate JWT cookie | [Tour operator portal](#tour-operator-portal) |
| Dashboard | Guest manage-booking `/api/changes/booking`, `/api/changes/request` | HMAC link token shared with the core API | [Signed manage-booking links](#signed-manage-booking-links) |
| Dashboard | `POST /api/stripe/webhook` | Stripe signature | [Stripe webhook](#stripe-webhook) |
| Both | Shared Postgres | `DATABASE_URL` per service | [DATA_MODEL.md](DATA_MODEL.md) |

Shared secrets: `BOOKING_LINK_SECRET` (must be identical on both services) and the database credentials. Every route of the dashboard is listed with its auth level in [API.md](API.md).

## Staff authentication

`server/src/auth.js`, `server/src/lib/session-domain.js`, `server/src/routes/auth.js`.

- **Sign-in** by email address (or legacy username), case-insensitive. Unknown account and wrong password get the same 401 message, and the same work: an unknown, deactivated or password-less account is refused only after a bcrypt comparison against a dummy hash of the same cost (`spendBcryptTime` in `auth.js`), so response time does not reveal which accounts exist.
- **Passwords**: bcrypt (bcryptjs, cost 12). Minimum length 8 (`validatePassword`); no complexity or breached-password check.
- **Session cookie** `teemail_session` (name configurable via `SESSION_COOKIE_NAME`): an HS256 JWT signed with `JWT_SECRET`, `httpOnly`, `SameSite=Lax`, `Secure` when `NODE_ENV=production`, 12 h lifetime (`TOKEN_TTL`, `maxAge`). Claims: `sub`, `username`, `customerId`, `fullName`, `role`, `sv` (session version).
- **Every request re-validates** the token against `dashboard_users` (`requireAuth` → `evaluateSession`): the account must exist, be active, have a club, and its `session_version` must equal the token's `sv`. **Role and club come from the database row, never from the token**, so a demotion or club change applies on the next request. Rows are cached per process for 20 s (`SESSION_CACHE_MS`); the cache entry is dropped immediately on the instance that made the change.
- **Revocation** (`bumpSessionVersion`): sign-out (ends the account's sessions everywhere), password change or reset, role change, deactivation (`patchRevokesSessions`), deletion.
- **Temporary passwords** (Streamlit-era accounts): stored as bcrypt hashes; plaintext rows are hashed at boot (`hashLegacyTempPasswords`) or on first use (constant-time compare). A temp-password session is held on the change-password screen: every route except `/api/auth/me`, `/change-password` and `/logout` answers 403 (`allowedDuringPasswordChange`). New accounts never get a temp password.
- **Login throttling** (`lib/throttle.js`): failures only, 5 per 15 min per account and 20 per 15 min per client IP → 429 with `Retry-After`; a successful sign-in clears the account's count. Wrong current passwords on `/change-password` are limited the same way (5 per 15 min, keyed by account id).
- **Client IP**: `app.set('trust proxy', 1)` — Render's single proxy hop; a client-supplied `X-Forwarded-For` prefix is ignored (`clientIp` in `lib/request-guard.js`).
- `JWT_SECRET` unset ⇒ an ephemeral random secret is generated with a warning (sessions end on restart; instances disagree). `render.yaml` generates one.

## Authorisation

- **Club scoping**: every staff query filters on `req.user.customerId` (`dashboard_users.customer_id`); writes include it in the `WHERE` clause; ids supplied by the browser (operator id, booking ids, waitlist ids, email ids) are checked against the club and answer 404 otherwise. Process-wide state is filtered too: the Stripe webhook log (`recentWebhooks(club)`) and payment-sync results (`scopeSyncResult`) show a club only its own bookings. Evidence: `server/test/integration/routes.test.js` "club scoping (IDOR)".
- **Roles** (`dashboard_users.role`, CHECK `admin|staff`): `requireAdmin` guards `/api/users/*`, every delete (`DELETE /api/bookings/:id`, `/api/imports/:batchId`, `/api/operators/:id`, `/api/waitlist/:id`) and `GET /api/payments/diagnostics`; the SPA hides those controls from staff. Everything else is open to staff. The Users page refuses self-demotion, self-deactivation and removing the last active admin (`guardSelfLockout`, `guardDelete` in `lib/users-domain.js`).
- **Operator portal isolation**: portal tokens carry `kind: 'operator'`; `requireAuth` refuses them and `requireOperator` refuses anything else, even though both are signed with `JWT_SECRET`. Portal handlers load only the operator's own bookings and answer 404 for any other reference.
- **Guests** never authenticate; a manage link reaches exactly one booking.

## CSRF

`csrfProtection` in `server/src/lib/request-guard.js`, mounted on `/api` after the Stripe webhook:

1. Non-safe methods must carry `X-Requested-With: teemail` (set by `web/src/lib/api.js`). Browsers cannot add a custom header to a cross-site form post, and a cross-site `fetch` with it needs a CORS preflight that production never grants (CORS is only enabled outside production, for `http://localhost:5173`).
2. If an `Origin` header is present it must be this host's origin or a configured `APP_URL`'s (plus the Vite origin outside production). The default address emailed links fall back to when `APP_URL` is unset is never trusted; in production a missing `APP_URL` is logged as an error at boot.
3. `SameSite=Lax` cookies add a second layer. The Stripe webhook is the only exempt path (it authenticates by signature).

Refusals are 403 and logged. Evidence: `server/test/request-guard.test.js`, integration "CSRF header".

## Security headers and CSP

`helmet` 8 in `server/src/app.js`, directives from `contentSecurityDirectives()`. Response headers in production (verified against a running instance):

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:;
  img-src 'self' data: https:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none';
  form-action 'self'; object-src 'none'; upgrade-insecure-requests
Strict-Transport-Security: max-age=15552000; includeSubDomains          (180 days)
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Origin-Agent-Cluster: ?1
X-DNS-Prefetch-Control: off; X-Download-Options: noopen; X-Permitted-Cross-Domain-Policies: none; X-XSS-Protection: 0
```

`X-Powered-By` is disabled. `style-src 'unsafe-inline'` is needed for React `style` attributes and chart rendering; scripts have no inline allowance. React escapes rendered text; staff-composed email bodies and quoted guest emails are HTML-escaped (`buildReplyEmail` in `lib/inbox-domain.js`, `escapeHtml` in `lib/email-layout.js`). No `Permissions-Policy` header and no `Cache-Control: no-store` on API responses (see residual risks).

## One-time tokens: password reset, invitation, portal sign-in

`server/src/lib/password-reset-domain.js`, `routes/auth.js`, `routes/users.js`, `routes/portal.js`, `lib/portal-domain.js`.

| | Reset | Invitation | Portal sign-in |
|---|---|---|---|
| Token | 32 bytes CSPRNG, base64url | same | same |
| Stored | SHA-256 only (`password_resets.token_hash`) | same, `purpose = 'invite'` | SHA-256 only (`operator_portal_links.token_hash`) |
| Lifetime | `PASSWORD_RESET_TTL_MINUTES` (60) | `USER_INVITE_TTL_MINUTES` (10,080 = 7 days) | 30 min |
| Single use | Redeeming burns every outstanding link of the user | same | Claimed atomically (`UPDATE … WHERE used_at IS NULL AND expires_at > NOW() RETURNING`) |
| Superseded by a new request | Yes | Yes | Yes (unused links for the same address are retired) |
| Enumeration | Same reply whether or not the account exists; reply sent before any lookup | n/a (admin action) | Same reply whether or not the address belongs to an operator |
| Throttle | Request: 5/15 min per identifier + 20/15 min per IP. Redeem: 20/15 min per IP | – | Request: 5/15 min per address + 20/15 min per IP. Redeem: 20/15 min per IP |
| Signs in? | **No** – the password is proved at sign-in; all sessions revoked | No | Yes – creates a portal session row and sets the cookie |
| Link | `APP_URL/reset-password?token=` | `APP_URL/accept-invite?token=` | `APP_URL/portal/sign-in?token=` |

Tokens in URLs are posted back in the request **body** (`/reset-password/check`, `/reset-password`, `/portal/session`) so they stay out of API access logs. A deactivated account's link is refused. Who may sign in to the portal: the operator's `contact_email`, or any address on one of its `email_domains` unless the domain is a consumer mailbox (`isConsumerDomain`: 148 listed domains plus 27 provider families such as `gmail.*`, `yahoo.*`, in `lib/operators-domain.js`); retired operators let nobody in.

## Tour operator portal

- Separate cookie `teemail_operator` (`httpOnly`, `SameSite=Lax`, `Secure` in production, 12 h), JWT `{kind:'operator', operatorId, club, email, sid}` signed with `JWT_SECRET`. `sid` is 32 random bytes; only its SHA-256 is stored, in `operator_portal_sessions` (migration `0006`) with an expiry.
- `requireOperator` checks on every request that the session row exists, is not revoked or expired and belongs to the same operator and club, then re-reads the operator: retired account, changed club, or an address no longer matching the contact/domains ends the session (401, cookie cleared). A signed token without a session row is refused.
- Operators can only **ask**: change/cancel requests go to Guest Requests as `Pending`; enquiries land in the Inbox. Payment amounts are the server-computed outstanding balance, never a client value.
- **Logout revokes the session row** (`revoked_at`), so a copied cookie stops working at once. Asking for a new sign-in link retires every unused link for that address.

## Signed manage-booking links

`server/src/lib/change-request-domain.js`, `server/src/routes/changes.js`. Scheme in [ARCHITECTURE.md](ARCHITECTURE.md#signed-booking-links-booking_link_secret).

- HMAC-SHA256 over `club|booking_id` with `BOOKING_LINK_SECRET` (fallback `JWT_SECRET`), truncated to 32 base64url chars (~192 bits), compared in constant time (`verifyBookingToken`). The club is part of the message, so a token for one club cannot open another club's booking with the same reference.
- **Expiry**: tokens never expire by themselves (shared format, already in guests' inboxes); the dashboard refuses the link **30 days after the play date** (`MANAGE_LINK_GRACE_DAYS`, HTTP 410). Undated bookings never expire.
- Every bad link answers the same 404 so references cannot be probed. Throttled per IP and per reference (lookup 30/15 min, submit 10/hour).
- The page returns only what the link holder already knows (no notes, phone, payment state). A guest can only **request**; nothing changes until staff approve (`readChangePolicy`: approval always required).
- Revocation: only all at once, by rotating `BOOKING_LINK_SECRET` on both services.

## Stripe webhook

`server/src/routes/stripe-webhook.js`, `verifyWebhookSignature` in `server/src/lib/stripe.js`.

- Mounted before the JSON parser with `express.raw` (≤ 1 MB) so the signature is checked over the exact bytes; before CSRF (server-to-server).
- `Stripe-Signature` `t=…,v1=…`: HMAC-SHA256 of `t.body` with `STRIPE_WEBHOOK_SECRET`, constant-time compare against every `v1`, timestamp within **300 s** (replay window). Missing secret → 503 (Stripe retries); bad signature → 400.
- Idempotent: the Stripe session/intent key is stored in `bookings.stripe_checkout_session_id` and used in the `UPDATE … WHERE stripe_checkout_session_id IS DISTINCT FROM $key`, so concurrent deliveries and the sync job cannot count a payment twice (`lib/record-payment.js`).
- Amounts come from Stripe's event, not from the dashboard. The booking is found by metadata (`booking_id` + `club`), then by payment link id.
- The same recording runs from a periodic pull of Stripe (`lib/payment-sync.js`), so a lost webhook does not lose a payment.
- No card data touches the dashboard: guests pay on Stripe-hosted Payment Links.

## Input handling and exports

- All SQL is parameterised. Interpolated identifiers come from fixed allow-lists in code (`lib/schema.js` column lists, `OPERATOR_COLUMNS`, campaign columns).
- **Body limits**: 200 kB JSON globally; 12 MB on `/api/imports` (an 8 MB file, base64); 1 MB raw on the Stripe webhook; 413 on overflow.
- **Uploads** (`routes/imports.js`, `lib/sheet-reader.js`): ≤ 8 MB decoded; `.xlsx` read as a stream and abandoned past 20,000 rows or 100 columns (zip-bomb guard); ≤ 5,000 rows written per import; preview writes nothing.
- **CSV formula defusing** (`lib/csv.js`): a cell starting with `= + - @ \t \r` is prefixed with `'` (plain numbers pass). Used by the bookings CSV export and the portal statement. The `.xlsx` export applies the same rule to every string cell (`defuseRow`) as defence in depth, keeping numbers, dates and booleans typed.
- Campaign and reminder runs re-read rows by club and cap batch sizes (200 bookings, 100 operators).

## Logging and PII

`server/src/lib/logger.js` (no `console` in `server/src`, enforced by ESLint).

- Plain lines by default; `LOG_FORMAT=json` writes one JSON object per line. `LOG_LEVEL` (default `info`). Output goes to stdout/stderr → Render's log stream; retention **TO CONFIRM (owner)**.
- Addresses typed into unauthenticated forms are logged masked (`maskForLog`: `j***@example.com`); the error handler logs method and path **without** the query string; the health check logs the database error but returns none.
- Logged unmasked: booking references, user ids, Stripe ids, and SendGrid/Stripe error texts (a SendGrid error body may name the recipient). Email bodies, passwords and tokens are not logged. Seed scripts print a generated demo password when run by hand (`npm run seed`), never at boot.
- **Sentry** (`lib/error-reporting.js`): only when `SENTRY_DSN` is set; `sendDefaultPii: false`, `includeLocalVariables: false`, `tracesSampleRate: 0`; release = `RENDER_GIT_COMMIT`. Errors passed to `logger.error` and unhandled rejections are reported. Every event and breadcrumb passes through `lib/sentry-scrub.js` (`beforeSend`, `beforeSendTransaction`, `beforeBreadcrumb`; the same rules as the core API's `observability.py`): the request is reduced to method and URL **without** its query string (no link tokens), cookies, headers, bodies and the user block are dropped, and query strings and email addresses are removed/masked in messages, exception values, breadcrumbs, extra, tags and contexts. Residual: free text that is neither an address nor a URL (a name in an error message) is not recognised. Whether Sentry is enabled in production, its region and retention: **TO CONFIRM (owner)**.

## Secrets management

- Render environment variables (`render.yaml`: `JWT_SECRET` generated; `DATABASE_URL`, `BOOKING_LINK_SECRET`, `APP_URL`, `SENDGRID_API_KEY`, `FROM_EMAIL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SENTRY_DSN` set by hand, `sync: false`). Optional: `VERO_PARTNER_KEY`, SendGrid template ids. Full list: [`.env.example`](../.env.example).
- `.env` is git-ignored; `.env.example` holds placeholders only. Config endpoints strip keys (`publicResetConfig`, `publicPaymentLinkConfig`, `publicVeroConfig`); the Stripe diagnostics (admin-only) report whether keys are set and the mode, never values.
- Rotation procedures: [DEPLOYMENT.md](DEPLOYMENT.md#secret-rotation). Rotation schedule: **TO CONFIRM (owner)**.

## Transport and database

- TLS terminates at Render; HSTS on every response; `upgrade-insecure-requests` in production.
- **Postgres TLS** (`lib/db-ssl.js`, used by the server pool and the migration runner): any host other than `localhost`/`127.0.0.1`/`::1`/a Unix socket is reached over TLS whatever `DATABASE_URL` says (TLS parameters in the URL are replaced). The certificate is verified when `PGSSLROOTCERT` names the provider's CA bundle, when the URL says `sslmode=verify-ca|verify-full`, or with `DATABASE_SSL_VERIFY=true`; otherwise the connection is encrypted **without** certificate verification (the core API's `sslmode=require` behaviour), because some providers (e.g. Supabase) sign with a CA outside the public trust store. `DATABASE_SSL=disable` is the only way to plain text to a remote host and is logged at every start. Production setting (and whether to verify): **TO CONFIRM (owner)**.
- The migrations check the catalog before every DDL statement, so on a database that already has the schema they need no table ownership (only `CREATE` on schema `public` to create `schema_migrations` the first time). New objects still need DDL rights, and by default the same role serves requests (no separate least-privilege runtime role).

## Dependency management

- `package-lock.json` pins the tree; `npm ci` in CI. `overrides` forces `uuid` ≥ 11.1.1.
- CI job **Dependency audit**: `npm audit --omit=dev --audit-level=high` on every push and pull request (fails on high/critical in runtime dependencies). Dev dependencies are not audited. Currently 0 vulnerabilities.
- Node pinned by `.node-version` (22) and `engines` (`>=20 <25`); Render sets `NODE_VERSION=22`.
- No automated update bot is configured in this repository. Update cadence: **TO CONFIRM (owner)**.

## Rate limits and throttles

All in memory per Node process (`lib/throttle.js`), reset on restart.

| Surface | Limit | Response |
|---|---|---|
| Staff sign-in failures | 5 / 15 min per account; 20 / 15 min per IP | 429 + `Retry-After` |
| Wrong current password on change | 5 / 15 min per account id | 429 |
| Forgot password | 5 / 15 min per identifier; 20 / 15 min per IP | same 200 (silently not sent) |
| Reset redeem | 20 / 15 min per IP | 429 |
| Portal sign-in request | 5 / 15 min per address; 20 / 15 min per IP | same 200 (silently not sent) |
| Portal link redeem | 20 / 15 min per IP | 429 |
| Manage-booking lookup | 30 / 15 min per IP and per reference | 429 |
| Manage-booking request | 10 / hour per IP and per reference | 429 |
| Authenticated staff routes | none (batch caps on campaigns, imports) | – |

## Threat model

| Asset | Threat | Mitigation | Residual risk |
|---|---|---|---|
| Staff accounts | Password guessing / spraying | bcrypt, per-account and per-IP failure throttles, uniform 401 | Throttles in memory per instance; no MFA; 8-char minimum, no breach check |
| Staff sessions | Stolen cookie, stale privileges | `httpOnly`/`Secure`/`SameSite=Lax`, 12 h, DB re-check each request, `session_version` revocation | 20 s cache on other instances; sign-out ends all of the user's sessions (by design) |
| Club data | Cross-club access (IDOR) | `customer_id` from the DB row on every query; ids validated against club; payment webhook log and sync results filtered to the caller's club | No database-level isolation (no RLS) |
| Account takeover via email links | Token theft / guessing / replay | 256-bit tokens, SHA-256 at rest, short TTL, single use, superseded, no auto sign-in | `APP_URL` unset ⇒ links point at the default `https://democlub.teemail.io` (logged as an error at boot) |
| Portal | Free-mail domain sign-in, cross-operator access | Consumer-domain block list, per-request operator and session-row check, revocable sessions, superseded links, own-bookings-only queries | Domain-based trust |
| Guest bookings | Forged/guessed manage links | HMAC with shared secret, club-bound, constant-time, uniform errors, throttles, 30-day post-play cut-off | Links never expire before play; revocation only by global rotation; token in a GET query string |
| Payments | Forged "paid" webhook, double counting | Signature + 300 s tolerance, idempotency key in `WHERE`, amounts from Stripe | Shared Stripe account with other integrations is handled by skip-if-unmatched |
| Staff browsers | CSRF | Custom header + Origin check + SameSite | – |
| Staff browsers | XSS | React escaping, strict `script-src`, email HTML escaping | `style-src 'unsafe-inline'` |
| Spreadsheet users | CSV formula injection | `lib/csv.js` defusing in CSV and `.xlsx` | – |
| Availability | Large uploads, zip bombs, body floods | Body limits, streaming reader with row/column caps | No rate limit on authenticated routes |
| Secrets | Leakage via logs / API / repo | Masking, stripped config endpoints, `.env` ignored, Sentry scrubber | Free-text names in exception messages |
| Database | Interception | TLS enforced for every non-local host (`lib/db-ssl.js`) | Certificate not verified unless a CA or `DATABASE_SSL_VERIFY` is configured |
| Dependencies | Known-vulnerable packages | Lockfile, `npm audit` in CI | Audit only at CI time; dev deps not audited |

## Known issues and residual risks

1. **Throttles are in memory and per process.** A second instance doubles every budget and a restart resets them. `render.yaml` runs one instance; scaling out needs a shared store or an edge rate limiter.
2. **Session cache**: role/deactivation changes made on one instance reach another within 20 s.
3. **Manage-booking tokens** do not expire until 30 days after play and are carried in a GET query string (`/manage-booking?ref&token`, `/api/changes/booking?ref&token`), so they can appear in browser history and in any request log that records query strings (whether Render's does: **TO CONFIRM (owner)**).
4. **`BOOKING_LINK_SECRET` falls back to `JWT_SECRET`** when unset: one key then signs sessions and guest links, and the core API's links stop verifying (warned at boot in production).
5. **`APP_URL` unset** in production: emailed reset, invitation, portal and manage links point at the default `https://democlub.teemail.io` (`lib/brand.js`). Logged as an error at every boot; the CSRF origin check never trusts that default.
6. **No MFA**, no password complexity/breach check, no account-lockout notification.
7. **Database certificate verification** is opt-in (`PGSSLROOTCERT`, `sslmode=verify-full` or `DATABASE_SSL_VERIFY=true`); by default the connection is encrypted but the server certificate is not verified. **One database role** both migrates and serves.
8. **Migrations on bad existing rows**: a CHECK constraint that existing rows break is left `NOT VALID` (enforced for new and updated rows only) and a unique index that duplicates block is skipped, each with a warning, rather than failing the deploy or deleting data. Such a warning needs follow-up by hand ([DEPLOYMENT.md](DEPLOYMENT.md#first-deploy-of-the-migration-runner--checklist)).
9. **No `Cache-Control: no-store`** on authenticated API responses and no `Permissions-Policy` header.
10. **Sentry scrubbing** recognises URLs and email addresses only; other free text in an exception message is sent as is.

Fixed in the hardening branch (see [CHANGELOG.md](../CHANGELOG.md)): plaintext temp passwords, non-revocable sessions, unthrottled sign-in, spoofable client IP (`X-Forwarded-For` first entry), missing security headers and CSRF check, 12 MB bodies on every route, CSV formula injection, non-admin deletes, free-mail portal domains, whole-workbook upload parsing, runtime schema changes, ad-hoc delete/debug SQL in the repository; and, after the first audit draft: login timing differences, non-revocable portal sessions and non-superseded portal links, process-wide payment diagnostics shown to every club, unscrubbed Sentry events, database TLS not enforced, staff-level operator/waitlist deletes, unsanitised `.xlsx` strings, 16-bit `Math.random` booking references in a format the core API did not recognise, migrations that needed table ownership even when nothing changed.
