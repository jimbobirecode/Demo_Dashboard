# Database

- `migrations/` — the versioned schema of the database shared with the core API, applied automatically when the server starts (`npm run migrate` by hand, `npm run migrate:status` to list). How the runner works and how to add a migration: [docs/MIGRATIONS.md](../docs/MIGRATIONS.md). Never edit a file once it has been applied; add a new one.
- `seeds/` — sample data for demos and local development only (`psql "$DATABASE_URL" -f db/seeds/<file>.sql` after migrating, or `npm run seed`). Never run against production.

Table reference: [docs/DATA_MODEL.md](../docs/DATA_MODEL.md).
