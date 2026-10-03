# Schema migrations

This repository owns the schema of the Postgres database it shares with the core API. Every change to it is a numbered SQL file in [`db/migrations/`](../db/migrations), applied by [`server/src/db/migrate.js`](../server/src/db/migrate.js). The core API never alters the schema; it only checks the `bookings` columns it needs at start-up.

Current files:

| Version | File | Content |
|---|---|---|
| 0001 | `0001_baseline_bookings.sql` | `bookings`, `tour_operators`, `waitlist`, `tee_times` |
| 0002 | `0002_baseline_accounts.sql` | `dashboard_users`, `password_resets` |
| 0003 | `0003_baseline_operator_portal.sql` | `operator_portal_links` |
| 0004 | `0004_baseline_guest_requests_and_inbox.sql` | `booking_change_requests`, `email_messages` |
| 0005 | `0005_retire_legacy_statuses.sql` | `Pending` → `Inquiry`, `Confirmed` → `Booked` |
| 0006 | `0006_operator_portal_sessions.sql` | `operator_portal_sessions` (revocable portal sessions) |
| 0007 | `0007_email_messages_message_id.sql` | `email_messages.message_id`, unique inbound Message-ID index, pending-row index (core API) |

`0001`–`0004` are a **baseline**: they reproduce the schema production was running on when versioned migrations were introduced (folding in the retired `migration_*.sql` files and the core API's old runtime DDL), idempotently, so they are no-ops on a database that already has it — without needing to own its tables (see [Guarded DDL](#guarded-ddl)). What they change on the existing production database, and the first-deploy checklist: [DEPLOYMENT.md](DEPLOYMENT.md#first-deploy-of-the-migration-runner--checklist). Resulting tables: [DATA_MODEL.md](DATA_MODEL.md).

## How the runner works

- **When**: on every server start, before it listens (`server/src/index.js`). A failure logs `[migrate] could not bring the database schema up to date — not starting. <file> failed (at character N): <postgres error>` and exits with status 1, so a deploy with a broken migration never serves traffic. By hand: `npm run migrate` (uses `DATABASE_URL`, loaded from `.env` in the current directory).
- **Order**: files matching `NNNN_lower_snake_name.sql` in ascending version. A badly named file, a duplicate version, or a file containing its own `BEGIN`/`COMMIT`/`ROLLBACK` is refused before anything runs.
- **Record**: `public.schema_migrations (version, name, checksum, applied_at, duration_ms)`, created by the runner.
- **One transaction per file**: `BEGIN`; `SET LOCAL lock_timeout = '15s'`; the file; the `schema_migrations` insert; `COMMIT`. On error everything in that file rolls back and it is not recorded; earlier files stay applied.
- **Checksums**: SHA-256 of the file with CRLF normalised to LF. If an applied file's checksum no longer matches, the runner refuses to continue (`… has changed since it was applied … (checksum mismatch)`), which stops the server from booting.
- **Concurrency**: `pg_advisory_lock(7311420042)` around the whole run. A second instance booting at the same time waits, then finds nothing to do.
- **Unknown versions**: a version in `schema_migrations` with no file (e.g. after rolling code back) is a warning, not an error.
- **Warnings**: `RAISE WARNING` from a migration is logged at `warn` level (used by `0002` when duplicate accounts prevent a unique index).

## Guarded DDL

`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `COMMENT ON` and `CREATE INDEX IF NOT EXISTS` all require ownership of the table even when they would change nothing, and the production tables may be owned by another role. So each file defines a few helpers in `pg_temp` (session-local, dropped at the end of the file) and every DDL statement goes through them:

| Helper | Does | When the object exists |
|---|---|---|
| `pg_temp.has_column(table, column)` | catalog lookup (`pg_attribute`) | – |
| `pg_temp.ensure_column(table, column, definition)` | `ALTER TABLE … ADD COLUMN` | nothing |
| `pg_temp.ensure_index(name, ddl)` | runs the `CREATE INDEX` | nothing |
| `pg_temp.ensure_unique_index(name, ddl)` | runs the `CREATE UNIQUE INDEX`; duplicates → `WARNING`, index skipped | nothing |
| `pg_temp.ensure_check(table, name, expr)` | `ADD CONSTRAINT … CHECK (…) NOT VALID`, then `VALIDATE`; violating rows → `WARNING`, left `NOT VALID` (still enforced for new rows) | nothing |
| `pg_temp.ensure_comment(table, column, text)` | `COMMENT ON` when missing or different; not the owner → `WARNING`, skipped | nothing |

Tables are created inside `DO` blocks guarded by `to_regclass(…) IS NULL`; one-off backfills are tied to the creation of their column (`IF NOT pg_temp.has_column(…)`). Data safety comes first: no migration deletes or rewrites rows to make a constraint or index fit.

Proved by `server/test/integration/migrate.test.js` ("a role that owns no table can run them", "a CHECK is left NOT VALID and a unique index skipped") and by migrating a database rebuilt from the retired `migration_*.sql` files: its schema dump equals a fresh database's, and a second run is a no-op.

## Commands

```bash
npm run migrate          # apply pending migrations
npm run migrate:status   # list applied (with timestamp) and pending files; changes nothing
```

Both take the advisory lock and verify checksums. `npm run migrate:status` also fails on an edited file, so it is a safe pre-deploy check.

## Adding a migration

1. Create `db/migrations/NNNN_short_name.sql`, one above the highest existing version (e.g. `0006_add_booking_flags.sql`). Lower-case snake case only.
2. Plain SQL. **No `BEGIN`/`COMMIT`** — the runner wraps the file. Consequently no `CREATE INDEX CONCURRENTLY` or other statements that cannot run in a transaction.
3. Use the guard helpers for every DDL statement (copy the helper block from the latest file and drop the helpers at the end). Tie one-off backfills to the creation of their column so they run once on any database. Add CHECK constraints through `ensure_check` (never a plain `ADD CONSTRAINT`), and unique indexes through `ensure_unique_index`.
4. Data changes must be safe on production as it is today, and fast: long statements hold locks the core API waits on.
5. If the core API reads or writes the new column, add it to the core API's `REQUIRED_BOOKING_COLUMNS` / fixtures in the same release, and deploy this repository first.
6. Test: `npm run migrate` against a scratch database twice (the second run must print `schema up to date`), then `TEST_DATABASE_URL=… npm run test:server` (the integration suite applies every migration to a fresh database and checks idempotency, concurrency and rollback; [TESTING.md](TESTING.md)).
7. Update [DATA_MODEL.md](DATA_MODEL.md) and, if personal data is added, [DATA_FLOWS.md](DATA_FLOWS.md).

## Never edit an applied migration

Once a file has been applied anywhere (any environment, including a colleague's), it is immutable. Fix forward with a new file. If an edit slipped through and a database refuses to boot with a checksum mismatch, revert the file to the applied content (`git log -p db/migrations/<file>`) — do not update `schema_migrations.checksum` by hand unless the edit was whitespace-only and has been reviewed.

## Seeds

`db/seeds/*.sql` and `npm run seed` add **sample data only** (demo profile: references `RD-DEMO-…`; reserved `.example`/`example.com` addresses; club: the SQL files use the club with the most users, else `royal_dornoch`, while `npm run seed` uses `SEED_CLUB`, else the only existing users' club, else `CLUB_ID` (`teemail`)). They create no schema; run them after the migrations, never against production. CI runs every seed file against the migrated schema.
