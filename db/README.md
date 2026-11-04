# Database

- `migrations/` — the versioned schema of the database shared with the core API, applied automatically when the server starts (`npm run migrate` by hand, `npm run migrate:status` to list). How the runner works and how to add a migration: [docs/MIGRATIONS.md](../docs/MIGRATIONS.md). Never edit a file once it has been applied; add a new one.
- **Versions 0012-0014 do not exist, on purpose.** This dashboard once had its
  own Booking Lifecycle ladder at `0012`-`0014`; it was replaced by the booking
  trigger workflow ported from Dashboard_Beta, whose files are numbered from
  `0015` so they could not collide with the three they supersede. A database
  that applied the old `0012`-`0014` keeps their (now unread) columns and the
  runner simply reports three recorded versions with no file, which is a
  warning by design. `0011` is still live: it is the booked-customer webhook,
  which Dashboard_Beta does not have. Nothing needs renumbering — version
  numbers only have to ascend, not be contiguous.
- **`0015`-`0017` carry County Louth's name**, because they came across from
  Dashboard_Beta unchanged. They add nullable, read-only legacy columns that no
  page in this dashboard writes or reads, and they are kept rather than dropped
  because `0018` copies three of `0016`'s columns into the ones the email bot
  writes — so the chain cannot be broken without rewriting the SQL. On a demo
  database they are harmless no-op columns. The one-off import tooling and
  runbook that originally went with them are specific to that club and are not
  in this repository; each file's own header explains what it adds and why.
- `seeds/` — sample data for demos and local development only (`psql "$DATABASE_URL" -f db/seeds/<file>.sql` after migrating, or `npm run seed`). Never run against production.

Table reference: [docs/DATA_MODEL.md](../docs/DATA_MODEL.md).
