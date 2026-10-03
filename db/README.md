# Database migrations

This repository owns the schema of the database it shares with the core API.
Every change to it is a numbered SQL file in `db/migrations/`.

## Running

- The server applies pending migrations at start-up, before it listens. If one
  fails, the process exits with the file and the Postgres error in the log.
- `npm run migrate` applies them by hand (uses `DATABASE_URL`).
- `npm run migrate:status` lists applied and pending files without changing
  anything.

Applied files are recorded in `schema_migrations` (version, name, checksum,
applied_at). A Postgres advisory lock stops two instances migrating at once.

## Adding a migration

1. Create `db/migrations/NNNN_short_name.sql`, numbered one above the last
   file (`0006_add_booking_flags.sql`). Lower-case snake case only.
2. Write plain SQL. Do **not** add `BEGIN`/`COMMIT`: the runner wraps each file
   in a transaction, so a failure leaves nothing half-applied. (That also means
   no `CREATE INDEX CONCURRENTLY`.)
3. Prefer idempotent DDL (`IF NOT EXISTS`, `DO` blocks catching
   `duplicate_object` for constraints). Any data change must be safe on the
   production database as it is today.
4. Run `npm run migrate` against a scratch database, then `npm test` with
   `TEST_DATABASE_URL` set.
5. Never edit a file once it has been applied anywhere. The runner compares
   checksums and refuses to start when an applied file has changed; fix forward
   with a new file instead.

## Seeds

`db/seeds/*.sql` and `npm run seed` add sample data only. Run them after the
migrations.
