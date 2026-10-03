# Contributing

Internal project. Access and review rules: **TO CONFIRM (owner)**.

## Branching

- Work on a feature branch from the default branch; open a pull request to merge.
- Keep each pull request to one concern. Required reviewers / branch protection: **TO CONFIRM (owner)**.
- This repository owns the database schema shared with the core API. A change that needs a new column lands here first as a migration and is deployed before the core API change that uses it ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#deploy-order)).

## Commits

- Imperative, sentence-case subject that says what the change does for the system (e.g. "Refuse a manage link 30 days after play"), ≤ 72 characters where possible.
- Body explains why, and any operational impact (new env var, migration, deploy order).
- One logical change per commit.

## Before opening a pull request

```bash
npm ci
npm run lint
npm run format:check            # or npm run format
npm run test:coverage           # floors: lines 68%, branches 84%, functions 72%
npm run test:web
npm run build
npm audit --omit=dev --audit-level=high
# with a throwaway Postgres, for anything touching SQL, auth or migrations:
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:coverage
```

CI runs the same steps (plus migrations and seeds on Postgres 16) on every push and pull request; all must pass ([docs/TESTING.md](docs/TESTING.md)).

- Add or update tests for behaviour changes, especially anything touching authentication, sessions, club scoping, CSRF, signed links, payments, exports or what is emailed to guests and operators. Keep rules in pure `server/src/lib/*-domain.js` modules so they can be unit-tested without a database.
- Server code logs through `server/src/lib/logger.js` (ESLint forbids `console` in `server/src`).
- Every staff query must be scoped by the signed-in user's club (`req.user.customerId`); never trust a club or id sent by the browser.
- Update the docs in `docs/` and `.env.example` when you add or change a route, an environment variable, a limit, a table or a data flow.

## Database migrations

- Schema changes only through a new file `db/migrations/NNNN_lower_snake_name.sql`, one above the highest version ([docs/MIGRATIONS.md](docs/MIGRATIONS.md)).
- **Never edit a migration that has been applied anywhere**; fix forward with a new file. The runner refuses to start on a checksum mismatch.
- No `BEGIN`/`COMMIT` in the file (the runner wraps it); prefer idempotent DDL; data changes must be safe and quick on production as it is.
- Run it twice against a scratch database (`npm run migrate`; the second run must say `schema up to date`) and run the DB integration tests.
- No runtime DDL in application code.

## Secrets and personal data

- Never commit secrets, `.env` files, real guest emails or production data. `.env` is git-ignored; `.env.example` holds placeholders only.
- Test fixtures and seeds use invented people and data; use reserved domains (`example.com`, `.example`) for addresses.
- Do not log email bodies, tokens or full addresses; use `maskForLog()` (`server/src/lib/request-guard.js`) for addresses.
- If a secret is committed, treat it as leaked: rotate it ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#secret-rotation)) – removing it from history is not enough.

## Adding or updating a dependency

1. Add it to the right workspace (`npm install <pkg> -w server` or `-w web`; root for tooling) so `package-lock.json` records the exact version.
2. `npm ci` from a clean checkout on Node 22 (`.node-version`).
3. `npm audit --omit=dev --audit-level=high` must pass.
4. Note in the pull request why it is needed. A dependency that sends data to a new external service must be added to [docs/DATA_FLOWS.md](docs/DATA_FLOWS.md); a new browser origin needs a CSP change in `server/src/lib/request-guard.js`.
