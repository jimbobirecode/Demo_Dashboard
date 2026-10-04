# Operations runbook

Dashboard runbook, plus the parts of incident response and backup that cover the whole TeeMail product. Core API incidents (inbound email, Anthropic, webhook 503s): [core API OPERATIONS.md](https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/OPERATIONS.md).

On-call owner, escalation contacts and support hours: **TO CONFIRM (owner)**.

## Monitoring

| Signal | Where | What it tells you |
|---|---|---|
| `GET /api/health` | Render health check; external uptime monitor (**TO CONFIRM (owner)** whether one exists) | 200 `{ok:true,database:"connected"}` or 503 `{ok:false,status:"degraded"}`; the reason is in the log (`[api] health check failed: …`) |
| Boot log | Render logs after each deploy | `[migrate] …` result, `listening on …`, configuration warnings, `dashboard users by club` / `bookings by club`, `[payment-sync] checking Stripe … every N min` |
| Request errors | Render logs | `ERROR [api] <METHOD> <path> failed` with stack (query strings omitted) |
| Refusals | Render logs | `WARN [api] refused POST … : missing request header` (CSRF), `[auth] password reset throttled for j***@…`, `[portal] sign-in asked for an address on no operator account` |
| Payments | Render logs; drawer → **Check payment setup** (admin) | `[stripe] <event> <session>: <result>`, `[stripe] rejected webhook: …`, `[payment-sync] <booking>: …` |
| Sentry (if `SENTRY_DSN`) | Sentry project | Every `logger.error` carrying an Error, unhandled rejections |

Logs: readable lines by default; `LOG_FORMAT=json` (set in `render.yaml`) gives one object per line with `time`, `level`, `scope`, `msg`, `err`. `LOG_LEVEL=debug|info|warn|error`. Errors and warnings go to stderr. Log drain / retention: **TO CONFIRM (owner)**.

Useful read-only SQL:

```sql
-- Links out and unpaid, newest first
SELECT booking_id, club, payment_status, payment_link_amount, payment_link_sent_at, stripe_payment_link_id
  FROM bookings WHERE payment_status = 'Pending' AND stripe_payment_link_id IS NOT NULL
 ORDER BY payment_link_sent_at DESC NULLS LAST LIMIT 50;

-- Applied migrations
SELECT version, name, applied_at, duration_ms FROM schema_migrations ORDER BY version;

-- Accounts that cannot sign in
SELECT id, username, email, customer_id, role, is_active, must_change_password, password_hash IS NULL AS no_password
  FROM dashboard_users ORDER BY customer_id, username;
```

## Runbooks

### A payment was made but the booking is not marked paid

The dashboard learns of payments two ways: Stripe's webhook and its own sync (15 s after start, every `PAYMENT_SYNC_MINUTES` (2), on every bookings-list load at most every 10 s, and when the drawer opens a pending booking). Either records the payment once.

1. Open the booking → **Check Stripe for payment** (`POST /api/payments/bookings/:id/check`). If Stripe reports it paid, it is recorded and the receipt sent; done.
2. As admin, **Check payment setup** (`GET /api/payments/diagnostics`): secret key and mode, webhook secret, `APP_URL`, whether Stripe has an enabled endpoint at `<APP_URL>/api/stripe/webhook` for the right events, last webhook, last sync.
3. Webhook log (drawer, or `GET /api/payments/config` → `webhooks`, since the last restart; each club sees its own deliveries plus club-less ones such as refused signatures):
   - nothing received → no endpoint in Stripe for this URL, or it was created in the **other mode** (test vs live);
   - `rejected: Signature mismatch` → `STRIPE_WEBHOOK_SECRET` belongs to a different endpoint or mode;
   - `rejected: STRIPE_WEBHOOK_SECRET is not set` → set it (Stripe keeps retrying for up to 3 days);
   - `skipped: no matching booking` → the payment's metadata/link does not match a booking (link created elsewhere, or the booking was deleted);
   - `failed: Database error` → check `/api/health`; Stripe retries.
4. Sync: `POST /api/payments/sync` (or the drawer) returns `checked`, `recorded`, `errors`. `skipped: STRIPE_SECRET_KEY is not set` means the sync is off. Links older than 60 days are not polled; use the per-booking check.
5. If Stripe shows the payment but none of the above records it, record it by hand in the drawer's payment panel (amount paid, status) and note the Stripe reference.

### Emails are not being sent

1. The page that sends (Users, Guest Emails, Operator Reminders, payment panel) lists missing configuration: `SENDGRID_API_KEY`, `FROM_EMAIL`, template ids, `APP_URL`.
2. Logs: `reset email failed: SendGrid error 403: …`, `[portal] email failed: …`, `[changes] guest email failed: …`. 401/403 → key revoked or lacking Mail Send; "does not match a verified Sender Identity" → verify `FROM_EMAIL` or authenticate its domain; 400 on a template → wrong/deleted template id. `SendGrid timed out` → 15 s timeout.
3. SendGrid → Activity: was the message accepted, delivered, bounced, blocked?
4. Password reset and portal sign-in answer the same message whether or not they sent anything; check the log rather than the screen. Throttled requests log `throttled`.
5. Failed sends are not retried. Staff resend from the relevant page once fixed. Guest emails sent are in `email_messages` (`direction = 'outbound'`); a missing row means it did not go.

### Migration failure on deploy

Symptom: deploy fails its health check; log shows `[migrate] could not bring the database schema up to date — not starting. <file> failed …`. The previous deploy keeps serving (Render does not switch over to an instance that never became healthy), and the failed file was rolled back.

| Message | Cause | Fix |
|---|---|---|
| `must be owner of table …` | A migration must really change a table (a new column or index) that the role does not own. Already-complete objects never need ownership | `ALTER TABLE … OWNER TO <dashboard role>`, redeploy |
| `canceling statement due to lock timeout` | A long transaction held a lock > 15 s | Find it (`pg_stat_activity`), let it finish, redeploy at a quiet time |
| `WARNING … left NOT VALID` / `WARNING … unique index … was not created` (deploy succeeds) | Existing rows break a new constraint or index; nothing was deleted | Fix the data (pre-flight queries in [DEPLOYMENT.md](DEPLOYMENT.md#first-deploy-of-the-migration-runner--checklist)), then `ALTER TABLE … VALIDATE CONSTRAINT …` or add the index in a new migration |
| `has changed since it was applied … (checksum mismatch)` | An applied migration file was edited | Revert the file; put the change in a new migration |
| `version NNNN is also used by …` / naming / `remove BEGIN/COMMIT` | Bad migration file | Fix the file (it was never applied) |
| `DATABASE_URL is not set` / connection errors | Configuration | Fix `DATABASE_URL` |

Run `npm run migrate:status` with the production `DATABASE_URL` to see what is applied. Never edit `schema_migrations` by hand to get past an error.

### A staff member is locked out

1. **Too many attempts** (429, "Try again in N minutes"): 5 failures per account or 20 per IP in 15 minutes. Wait, or restart the service to clear all throttles (in memory).
2. **Forgot password**: "Forgot your password?" needs SendGrid + `SENDGRID_TEMPLATE_PASSWORD_RESET`; the link goes to `dashboard_users.email` (or the username if it is an address). An admin can re-send an **invitation** from Users to set a password.
3. **Deactivated** (`is_active = false`) or **no club** (`customer_id` null): sign-in fails / session refused. An admin reactivates on the Users page.
4. **Last admin locked out**: no in-app path. With database access, send a reset to a known address: `UPDATE dashboard_users SET email = '<address>' WHERE id = …;` then use "Forgot password". Avoid setting `password_hash` by hand unless a bcrypt hash is generated offline.
5. **Signed out repeatedly**: every sign-out, password change, role change or deactivation bumps `session_version` and ends all of that account's sessions, on every device; a changed `JWT_SECRET` or `SESSION_COOKIE_NAME` signs everyone out once.

### A tour operator cannot sign in

1. The address must be the operator's **contact email**, or on one of its **email domains**; consumer domains (gmail.com, outlook.com, …) never qualify by domain. Check the operator record on the Tour Operators page; it must be **active** (not retired).
2. Logs: `[portal] sign-in asked for an address on no operator account: j***@…` → address/domain not on any active operator. `sign-in link not emailed` → SendGrid not configured or failed.
3. Throttle: 5 requests per address / 20 per IP per 15 minutes (silently not sent).
4. The link works once, for 30 minutes; "expired or already used" → request a new one. Redeeming is a POST the sign-in page makes with JavaScript, so a plain link pre-fetch does not use it up, but a corporate mail scanner that opens links in a full browser can; if that recurs, ask the operator to allow-list the dashboard's domain in their scanner.
5. Signed in but then "Your session has ended" → the operator signed out elsewhere with the same cookie, the session expired (12 h), the operator was retired, or the address/domain was removed from the account. Portal cookies from before migration `0006` are refused once: sign in again.
6. Each new sign-in request retires the address's earlier unused links: only the newest email works.

### Guests report "That link is not valid" on manage-booking

- `BOOKING_LINK_SECRET` differs between the services or was rotated; the core API's `CLUB_ID` differs from the booking's `club`; or the link was truncated by the mail client.
- HTTP 410 "This booking has finished" → more than 30 days after the play date, by design.

## Backup and restore

The shared database holds all persistent state of both services; neither service keeps state on disk. Backups are a property of the Postgres provider.

| Item | Value |
|---|---|
| Database provider and plan | **TO CONFIRM (owner)** (code supports any Postgres; the core API has explicit Supabase handling) |
| Backup method (provider daily snapshots / PITR / own `pg_dump`) | **TO CONFIRM (owner)** |
| Backup frequency / retention | **TO CONFIRM (owner)** |
| Point-in-time recovery available and window | **TO CONFIRM (owner)** |
| Backup encryption and location (region) | **TO CONFIRM (owner)** |
| RPO | **TO CONFIRM (owner)** |
| RTO | **TO CONFIRM (owner)** |
| Restore test cadence / last restore test | **TO CONFIRM (owner)** |

### Taking an on-demand backup

Before any risky change (first migration deploy, bulk data fix): use the provider's on-demand backup, or

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > teemail-$(date +%Y%m%d-%H%M).dump
```

Store the file encrypted and access-controlled — it contains every guest's personal data.

### Restoring

1. Decide the target time and accept that writes after it are lost in **both** services (bookings, inbound emails, payments recorded).
2. Stop writes: suspend the core API (inbound email then queues at SendGrid, which retries) and the dashboard in Render.
3. Restore into a **new** database (provider PITR/snapshot restore, or `createdb` + `pg_restore --no-owner --role=<dashboard role> -d <new> <dump>`). Make the dashboard role the owner of the tables.
4. Check it: `npm run migrate:status` against it (all files applied, no checksum errors); row counts per club; recent bookings.
5. Point `DATABASE_URL` on **both** services at it; deploy the dashboard, then the core API.
6. Reconcile what happened after the restore point: Stripe dashboard payments (run **Sync** — it re-records payments for links still `Pending`), SendGrid Activity for emails received/sent, and tell staff which period was lost.

A restore test (steps 3–4 into a scratch database, timed) should be run at the cadence above and recorded.

## Incident response outline

Formal policy, severity levels and notification duties (including personal-data breach notification timelines): **TO CONFIRM (owner)**. Proposed outline, consistent with the core API runbook:

| Severity | Example | Response target |
|---|---|---|
| SEV1 | Personal-data exposure; payments recorded wrongly; both services down | **TO CONFIRM (owner)** |
| SEV2 | Dashboard down; emails or payments failing for all guests | **TO CONFIRM (owner)** |
| SEV3 | One feature degraded (reminders, Vero, analytics) | **TO CONFIRM (owner)** |

Roles: incident lead, communications, scribe — names and contacts **TO CONFIRM (owner)**.

1. **Detect** – Render health/uptime alert, Sentry, staff or guest report.
2. **Triage** – which service and component (dashboard API, core API, database, SendGrid, Stripe, Anthropic), personal-data impact, start time, severity.
3. **Contain** – e.g. rotate a leaked secret ([DEPLOYMENT.md](DEPLOYMENT.md#secret-rotation)); rotate `JWT_SECRET` to end every staff and portal session (or `UPDATE operator_portal_sessions SET revoked_at = NOW() WHERE revoked_at IS NULL` for the portal alone); rotate `BOOKING_LINK_SECRET` (both services) to kill all guest links; deactivate a compromised staff account (ends its sessions immediately); retire an operator account (ends portal access); unset `STRIPE_SECRET_KEY` to stop new payment links and the sync; core API containment switches are in its runbook.
4. **Eradicate / recover** – fix, deploy (dashboard before core API), run the post-deploy checks; restore from backup only if data is corrupted.
5. **Communicate** – club staff, affected guests/operators, and regulators where required (**TO CONFIRM (owner)**).
6. **Review** – blameless post-mortem within **TO CONFIRM (owner)** days: timeline, root cause, actions with owners; update these runbooks.
