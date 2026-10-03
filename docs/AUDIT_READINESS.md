# Audit readiness

An index for the external technical audit and penetration test of **TeeMail**: where each area is documented, implemented and tested, across both repositories.

| Repository | Stack | Links below |
|---|---|---|
| Dashboard — `jimbobirecode/Demo_Dashboard` (this repo) | Node 22 / Express / React | relative links |
| Core API — `jimbobirecode/Demo_core_api` | Python 3.11 / Flask / gunicorn | `https://github.com/jimbobirecode/Demo_core_api/blob/main/…` |

> **Branch note.** The hardening work and these documents are on `claude/amazing-newton-jmg7vw` in both repositories and will become `main` on merge. Links to the core API point at `main`; until the merge, replace `main` with `claude/amazing-newton-jmg7vw` in the URL.

Start with [ARCHITECTURE.md](ARCHITECTURE.md), then the two SECURITY documents.


## Evidence map

| Area | Documentation | Code | Tests / evidence |
|---|---|---|---|
| System architecture, trust boundaries | [ARCHITECTURE.md](ARCHITECTURE.md); [core README][core-readme] | [`server/src/app.js`](../server/src/app.js); [core `Conolidated.py`][core-app] | – |
| Personal data, subprocessors, retention | [DATA_FLOWS.md](DATA_FLOWS.md); [core DATA_FLOWS.md][core-flows] | – | – |
| Data model, table ownership, PII columns | [DATA_MODEL.md](DATA_MODEL.md) | [`db/migrations/`](../db/migrations) | [`server/test/integration/migrate.test.js`](../server/test/integration/migrate.test.js) |
| Attack surface (every route) | [API.md](API.md); [core API.md][core-api] | [`server/src/routes/`](../server/src/routes) | [`server/test/app-loads.test.js`](../server/test/app-loads.test.js) |
| Staff authentication, password storage, throttling | [SECURITY.md § Staff authentication](SECURITY.md#staff-authentication) | [`server/src/auth.js`](../server/src/auth.js), [`server/src/routes/auth.js`](../server/src/routes/auth.js), [`server/src/lib/throttle.js`](../server/src/lib/throttle.js) | [`routes.test.js`](../server/test/integration/routes.test.js) "sign-in"; [`throttle.test.js`](../server/test/throttle.test.js) |
| Session management and revocation | [SECURITY.md § Staff authentication](SECURITY.md#staff-authentication) | [`server/src/lib/session-domain.js`](../server/src/lib/session-domain.js), `requireAuth` in [`auth.js`](../server/src/auth.js) | [`session-domain.test.js`](../server/test/session-domain.test.js), [`session-auth.test.js`](../server/test/session-auth.test.js), `routes.test.js` "requireAuth" |
| Authorisation: club scoping (IDOR), roles | [SECURITY.md § Authorisation](SECURITY.md#authorisation) | `requireAdmin` in [`auth.js`](../server/src/auth.js); `WHERE club = …` in every router; [`users-domain.js`](../server/src/lib/users-domain.js) | `routes.test.js` "club scoping (IDOR)", "administrator-only routes"; [`users-domain.test.js`](../server/test/users-domain.test.js) |
| Tour operator portal isolation | [SECURITY.md § Tour operator portal](SECURITY.md#tour-operator-portal) | [`server/src/routes/portal.js`](../server/src/routes/portal.js), [`server/src/lib/portal-domain.js`](../server/src/lib/portal-domain.js) | `routes.test.js` "operator portal"; [`portal-domain.test.js`](../server/test/portal-domain.test.js) |
| CSRF | [SECURITY.md § CSRF](SECURITY.md#csrf) | [`server/src/lib/request-guard.js`](../server/src/lib/request-guard.js) | [`request-guard.test.js`](../server/test/request-guard.test.js); `routes.test.js` "CSRF header" |
| Security headers, CSP | [SECURITY.md § Security headers](SECURITY.md#security-headers-and-csp); [core SECURITY.md § headers][core-sec] | `helmet` in [`app.js`](../server/src/app.js), `contentSecurityDirectives`; [core `set_security_headers`][core-app] | `request-guard.test.js`; core [`test_http_routes.py`][core-t-http] |
| Reset / invitation / portal magic-link tokens | [SECURITY.md § One-time tokens](SECURITY.md#one-time-tokens-password-reset-invitation-portal-sign-in) | [`password-reset-domain.js`](../server/src/lib/password-reset-domain.js), [`routes/auth.js`](../server/src/routes/auth.js), [`routes/users.js`](../server/src/routes/users.js), [`routes/portal.js`](../server/src/routes/portal.js) | [`password-reset-domain.test.js`](../server/test/password-reset-domain.test.js), `portal-domain.test.js` |
| Signed booking links (shared HMAC) | [ARCHITECTURE.md § Signed booking links](ARCHITECTURE.md#signed-booking-links-booking_link_secret); [SECURITY.md § manage links](SECURITY.md#signed-manage-booking-links); [core SECURITY.md § links][core-sec] | [`change-request-domain.js`](../server/src/lib/change-request-domain.js), [`routes/changes.js`](../server/src/routes/changes.js); [core `booking_form.py`][core-form] (`booking_token`) | [`change-request-domain.test.js`](../server/test/change-request-domain.test.js), `routes.test.js` "guest manage-booking link"; core [`test_booking_form_security.py`][core-t-form] |
| Inbound email webhook authentication | [core SECURITY.md § Webhook][core-sec] | [core `Conolidated.py`][core-app] (`handle_inbound_email`) | core [`test_inbound_security.py`][core-t-inbound], [`test_guest_safety.py`][core-t-safety] |
| Sender verification (SPF/DKIM), guest-only actions | [core SECURITY.md § Sender verification][core-sec] | core `sender_authentication`, `_is_bookings_guest` | core `test_inbound_security.py` |
| LLM prompt injection | [core SECURITY.md § Prompt-injection][core-sec] | [core `llm_parser.py`][core-llm], `email_triage.py` | core [`test_email_triage.py`][core-t-triage], [`test_single_read.py`][core-t-single] |
| Pricing and booking integrity | [core SECURITY.md § Pricing][core-sec] | core `booking_form.py` (`quote_rounds`, `clean_lodging`), `club_config.price_rounds` | core [`test_replay_pricing.py`][core-t-price], `test_booking_form_security.py` |
| Payments, Stripe webhook | [SECURITY.md § Stripe webhook](SECURITY.md#stripe-webhook); [OPERATIONS.md § payments](OPERATIONS.md#a-payment-was-made-but-the-booking-is-not-marked-paid) | [`routes/stripe-webhook.js`](../server/src/routes/stripe-webhook.js), [`lib/stripe.js`](../server/src/lib/stripe.js), [`lib/record-payment.js`](../server/src/lib/record-payment.js), [`lib/payment-sync.js`](../server/src/lib/payment-sync.js) | [`payment-link-domain.test.js`](../server/test/payment-link-domain.test.js) (signature, idempotency rules) |
| Output escaping / XSS | [SECURITY.md § headers](SECURITY.md#security-headers-and-csp); [core SECURITY.md § Output escaping][core-sec] | [`inbox-domain.js`](../server/src/lib/inbox-domain.js), [`email-layout.js`](../server/src/lib/email-layout.js); core `email_templates.py`, Jinja autoescape | [`inbox-domain.test.js`](../server/test/inbox-domain.test.js) (escaping of staff replies and quoted emails); core `test_booking_form_security.py`, `test_inbound_security.py` |
| CSV / spreadsheet formula injection | [SECURITY.md § Input handling](SECURITY.md#input-handling-and-exports) | [`server/src/lib/csv.js`](../server/src/lib/csv.js) | [`csv.test.js`](../server/test/csv.test.js) |
| File upload limits | [SECURITY.md § Input handling](SECURITY.md#input-handling-and-exports) | [`routes/imports.js`](../server/src/routes/imports.js), [`lib/sheet-reader.js`](../server/src/lib/sheet-reader.js) | [`sheet-reader.test.js`](../server/test/sheet-reader.test.js), [`import-domain.test.js`](../server/test/import-domain.test.js) |
| Rate limiting | [SECURITY.md § Rate limits](SECURITY.md#rate-limits-and-throttles); [core SECURITY.md § Rate limits][core-sec] | [`lib/throttle.js`](../server/src/lib/throttle.js); [core `rate_limit.py`][core-rl] | `throttle.test.js`, `routes.test.js` lockout; core `test_booking_form_security.py` |
| SQL injection | [SECURITY.md § Input handling](SECURITY.md#input-handling-and-exports) | parameterised `query()` in [`server/src/db.js`](../server/src/db.js); column allow-lists in [`lib/schema.js`](../server/src/lib/schema.js); core `db.py`, `email_log.py` | core [`test_db_layer.py`][core-t-db]; `routes.test.js` |
| Logging, PII masking, Sentry | [SECURITY.md § Logging](SECURITY.md#logging-and-pii); [core SECURITY.md § Logging, Sentry][core-sec] | [`lib/logger.js`](../server/src/lib/logger.js), [`lib/error-reporting.js`](../server/src/lib/error-reporting.js), `maskForLog`; [core `observability.py`][core-obs] | [`logger.test.js`](../server/test/logger.test.js); core [`test_observability.py`][core-t-obs] |
| Transport / database TLS | [SECURITY.md § Transport](SECURITY.md#transport-and-database); [core SECURITY.md § Transport][core-sec] | [`server/src/db.js`](../server/src/db.js); core `club_config.pg_connect_kwargs` | core [`test_config_security.py`][core-t-config] |
| Secrets management and rotation | [SECURITY.md § Secrets](SECURITY.md#secrets-management); [DEPLOYMENT.md § Secret rotation](DEPLOYMENT.md#secret-rotation); [core DEPLOYMENT.md][core-deploy] | [`render.yaml`](../render.yaml), [`.env.example`](../.env.example); core `.env.example` | – |
| Dependency management | [SECURITY.md § Dependency management](SECURITY.md#dependency-management); [core SECURITY.md][core-sec] | `package-lock.json`; core `requirements*.txt` (pinned) | CI `npm audit --omit=dev --audit-level=high`; core CI `pip-audit` |
| Schema changes and deploy safety | [MIGRATIONS.md](MIGRATIONS.md), [DEPLOYMENT.md § First deploy](DEPLOYMENT.md#first-deploy-of-the-migration-runner--checklist) | [`server/src/db/migrate.js`](../server/src/db/migrate.js); core `db.check_bookings_schema` | `migrate.test.js`; CI job "Migrations and DB integration tests"; core [`test_db_schema.py`][core-t-schema] |
| Monitoring, runbooks, backup/restore, incident response | [OPERATIONS.md](OPERATIONS.md); [core OPERATIONS.md][core-ops] | `/api/health` in [`app.js`](../server/src/app.js); core `/health` | – |
| CI and test coverage | [TESTING.md](TESTING.md); [core TESTING.md][core-testing] | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml); [core `ci.yml`][core-ci] | Coverage floors: dashboard lines 68 / branches 84 / functions 72 %; core 62 % |
| Threat model and residual risks | [SECURITY.md § Threat model](SECURITY.md#threat-model), [§ Known issues](SECURITY.md#known-issues-and-residual-risks); [core SECURITY.md § Threat model][core-sec] | – | – |

[core-readme]: https://github.com/jimbobirecode/Demo_core_api/blob/main/README.md
[core-app]: https://github.com/jimbobirecode/Demo_core_api/blob/main/Conolidated.py
[core-form]: https://github.com/jimbobirecode/Demo_core_api/blob/main/booking_form.py
[core-llm]: https://github.com/jimbobirecode/Demo_core_api/blob/main/llm_parser.py
[core-rl]: https://github.com/jimbobirecode/Demo_core_api/blob/main/rate_limit.py
[core-obs]: https://github.com/jimbobirecode/Demo_core_api/blob/main/observability.py
[core-ci]: https://github.com/jimbobirecode/Demo_core_api/blob/main/.github/workflows/ci.yml
[core-api]: https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/API.md
[core-sec]: https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/SECURITY.md
[core-flows]: https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/DATA_FLOWS.md
[core-deploy]: https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/DEPLOYMENT.md
[core-ops]: https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/OPERATIONS.md
[core-testing]: https://github.com/jimbobirecode/Demo_core_api/blob/main/docs/TESTING.md
[core-t-http]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_http_routes.py
[core-t-form]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_booking_form_security.py
[core-t-inbound]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_inbound_security.py
[core-t-safety]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_guest_safety.py
[core-t-triage]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_email_triage.py
[core-t-single]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_single_read.py
[core-t-price]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_replay_pricing.py
[core-t-db]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_db_layer.py
[core-t-obs]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_observability.py
[core-t-config]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_config_security.py
[core-t-schema]: https://github.com/jimbobirecode/Demo_core_api/blob/main/tests/test_db_schema.py

## Test environment notes for the pen test

- Use a non-production deployment of both services with their own database, Stripe **test-mode** keys, a SendGrid sandbox or test sender, and `CLUB_PROFILE=demo_club` on the core API. Sample data: `npm run seed` (dashboard).
- Two clubs are needed to test cross-club isolation: create a second `customer_id` and accounts for it (the integration tests do the same).
- Throttles are per process and in memory; restart the dashboard between brute-force test runs to reset them.
- Never set `ALLOW_UNAUTHENTICATED_INBOUND` (core API) or `TEST_DATABASE_URL` on a tested deployment.

## Known findings to read first

The residual-risk lists already record what the authors know: [dashboard](SECURITY.md#known-issues-and-residual-risks) and [core API][core-sec]. Items an auditor will want to check first: in-memory throttles, non-expiring HMAC links (dashboard cut-off 30 days after play), `APP_URL` default, process-wide payment diagnostics, Sentry without a scrubber on the dashboard, database TLS not enforced by the dashboard, one database role for migrations and runtime.

## Open items: TO CONFIRM (owner)

Consolidated from both repositories. Each is marked **TO CONFIRM (owner)** where it appears.

**Organisation and legal**

1. Legal entity name and registered address (`LICENSE`, both).
2. Security contact / vulnerability-reporting route (SECURITY.md, both).
3. Repository access and review rules; required reviewers / branch protection; whether passing CI is enforced (CONTRIBUTING.md, TESTING.md, both).
4. Controller/processor roles (golf club vs TeeMail) and lawful basis (DATA_FLOWS.md, both).
5. Data-subject request procedure, owner and response time (DATA_FLOWS.md, both).

**Hosting and infrastructure**

6. Render plan, region and instance count; production branch; auto-deploy (DEPLOYMENT.md, both); which mechanism pins Python on the core API service.
7. Whether Render's HTTP request logs record query strings (core webhook `?key=`; dashboard manage-link `token`); Render log retention and any log drain.
8. Whether an external uptime monitor exists.
9. Postgres provider and plan in production; region; encryption at rest; `sslmode` used (`verify-full` recommended); whether separate database roles are used.
10. Backup method, frequency and retention; PITR; RPO; RTO; restore-test cadence and last test (OPERATIONS.md, both).

**Subprocessors**

11. Region / DPA / retention for SendGrid, Anthropic, Stripe, Club Vero (and who operates Club Vero); whether Sentry is enabled in production, its region and retention (DATA_FLOWS.md, both).

**Retention**

12. Retention for `bookings`, `email_messages`, `booking_change_requests`, `waitlist`, `tour_operators`, `dashboard_users`, `password_resets`, `operator_portal_links`, Render logs, Sentry events, SendGrid data, Anthropic inputs/outputs, Stripe records, Club Vero data, database backups (DATA_FLOWS.md, both).

**Secrets and dependencies**

13. Secret rotation schedule and who may rotate (DEPLOYMENT.md, SECURITY.md, both).
14. Whether SendGrid retries Inbound Parse posts refused with a 4xx during `INBOUND_WEBHOOK_SECRET` rotation (core DEPLOYMENT.md).
15. Dependency update cadence; no update bot is configured in either repository (SECURITY.md, both).

**Operations**

16. On-call owner, escalation contacts, support hours (OPERATIONS.md, both).
17. Incident-response policy, severity levels and response targets, roles, personal-data breach notification duties and timelines, regulator communication, post-mortem deadline (OPERATIONS.md, both).

Answered here for the core API's open question "whether the dashboard offers a resend" of manage links after rotating `BOOKING_LINK_SECRET`: there is no dedicated resend button, but every staff reply about a booking (Inbox / booking drawer) and every change-request outcome email carries a freshly signed manage link ([DEPLOYMENT.md](DEPLOYMENT.md#booking_link_secret)).
