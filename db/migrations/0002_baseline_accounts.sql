-- Baseline, part 2: dashboard accounts, roles, sessions and reset links.
--
-- Folds in the dashboard_users table (previously created by the demo seed and
-- migration_upgrade_existing_db.sql), migration_add_password_reset.sql,
-- migration_add_user_management.sql and migration_add_session_version.sql.
-- Idempotent; one-off backfills run only when their column is created.


-- ---------------------------------------------------------------------------
-- Guards. Every statement below checks the catalog first and does nothing
-- when its object already exists, so on a database that already has this
-- schema the file needs no ownership of the tables (ALTER TABLE, COMMENT and
-- CREATE INDEX all demand it even when they would change nothing). The
-- helpers live in pg_temp, last only for this session and are dropped at the
-- end of the file.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.has_column(tbl text, col text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('public.' || quote_ident(tbl))
                    AND attname = col AND attnum > 0 AND NOT attisdropped)
$$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_column(tbl text, col text, definition text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT pg_temp.has_column(tbl, col) THEN
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I %s', tbl, col, definition);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    EXECUTE ddl;
  END IF;
END $$;

-- A unique index that existing duplicates would block: reported, not fatal.
-- Nothing is deleted to make room for it; resolve the rows by hand and add
-- the index in a later migration.
CREATE OR REPLACE FUNCTION pg_temp.ensure_unique_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    BEGIN
      EXECUTE ddl;
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'existing rows hold duplicates, so the unique index % was not created; resolve them and add it in a new migration', name;
    END;
  END IF;
END $$;

-- A CHECK constraint is added NOT VALID (enforced for every new or updated
-- row, existing rows not scanned), then validated. Rows that already break it
-- leave it NOT VALID with a warning instead of failing the deploy.
CREATE OR REPLACE FUNCTION pg_temp.ensure_check(tbl text, name text, expr text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = to_regclass('public.' || quote_ident(tbl)) AND conname = name) THEN
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID', tbl, name, expr);
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', tbl, name);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'existing rows of % break %; it is enforced for new rows but left NOT VALID', tbl, name;
    END;
  END IF;
END $$;

-- Comments are documentation: set when missing or different, and skipped with
-- a warning (never an error) when this role does not own the table.
CREATE OR REPLACE FUNCTION pg_temp.ensure_comment(tbl text, col text, body text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  rel regclass := to_regclass('public.' || quote_ident(tbl));
  current_text text;
BEGIN
  IF col IS NULL THEN
    current_text := obj_description(rel, 'pg_class');
  ELSE
    current_text := col_description(rel, (SELECT attnum FROM pg_attribute WHERE attrelid = rel AND attname = col));
  END IF;
  IF current_text IS NOT DISTINCT FROM body THEN
    RETURN;
  END IF;
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = rel), 'MEMBER') THEN
    RAISE WARNING 'not the owner of %, so its comment was left as it is', tbl;
    RETURN;
  END IF;
  IF col IS NULL THEN
    EXECUTE format('COMMENT ON TABLE public.%I IS %L', tbl, body);
  ELSE
    EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', tbl, col, body);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.dashboard_users') IS NULL THEN
    CREATE TABLE public.dashboard_users (
        id                   SERIAL PRIMARY KEY,
        username             VARCHAR(255) UNIQUE NOT NULL,
        password_hash        TEXT,
        temp_password        TEXT,
        customer_id          VARCHAR(255),
        full_name            VARCHAR(255),
        is_active            BOOLEAN DEFAULT TRUE,
        must_change_password BOOLEAN DEFAULT FALSE,
        last_login           TIMESTAMP
    );
  END IF;
END $$;

-- Where reset links go. When the column is introduced, accounts whose
-- username is already an address get it copied across (the API falls back to
-- the username anyway; this only makes it explicit).
DO $$
BEGIN
  IF NOT pg_temp.has_column('dashboard_users', 'email') THEN
    ALTER TABLE public.dashboard_users ADD COLUMN email TEXT;
    UPDATE public.dashboard_users SET email = username WHERE username LIKE '%@%.%';
  END IF;
END $$;

SELECT pg_temp.ensure_comment('dashboard_users', 'email',
  'Address password reset links are sent to; falls back to username when it is an email address');

-- What an account may do: 'admin' can manage other accounts, 'staff' is
-- everything else. When roles are introduced every existing account becomes
-- an admin — before roles they could already do everything, and locking the
-- club out of its own dashboard on upgrade day would be worse. New accounts
-- default to 'staff'.
DO $$
BEGIN
  IF NOT pg_temp.has_column('dashboard_users', 'role') THEN
    ALTER TABLE public.dashboard_users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';
    UPDATE public.dashboard_users SET role = 'admin';
  END IF;
END $$;

SELECT pg_temp.ensure_column('dashboard_users', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
SELECT pg_temp.ensure_column('dashboard_users', 'created_by', 'TEXT');
SELECT pg_temp.ensure_column('dashboard_users', 'invited_at', 'TIMESTAMPTZ');
-- Bumped to end every outstanding session for the account.
SELECT pg_temp.ensure_column('dashboard_users', 'session_version', 'INTEGER NOT NULL DEFAULT 0');

SELECT pg_temp.ensure_comment('dashboard_users', 'role',
  'admin = may manage other accounts; staff = everything else');
SELECT pg_temp.ensure_comment('dashboard_users', 'invited_at',
  'When an invitation was last emailed. Whether it has been accepted is read from password_hash, not from here');
SELECT pg_temp.ensure_comment('dashboard_users', 'session_version',
  'Bumped to end every outstanding session for this account; sessions carry the value they were issued with');

SELECT pg_temp.ensure_check('dashboard_users', 'dashboard_users_role_check',
  'role IN (''admin'', ''staff'')');

-- One account per address, and one per login spelled in any case: logins are
-- matched case-insensitively.
--
-- A database already holding duplicates cannot take the index. That is
-- reported (the migration runner logs the warning) rather than allowed to stop
-- the dashboard booting; resolve the duplicate by hand and add the index with
-- a new migration.
SELECT pg_temp.ensure_unique_index('idx_dashboard_users_email',
  $ddl$CREATE UNIQUE INDEX idx_dashboard_users_email ON public.dashboard_users (LOWER(email)) WHERE email IS NOT NULL$ddl$);

SELECT pg_temp.ensure_unique_index('idx_dashboard_users_username',
  $ddl$CREATE UNIQUE INDEX idx_dashboard_users_username ON public.dashboard_users (LOWER(username))$ddl$);

-- ---------------------------------------------------------------------------
-- password_resets: outstanding reset links and invitations. Only the SHA-256
-- of a token is stored, so a leaked database cannot take over an account.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.password_resets') IS NULL THEN
    CREATE TABLE public.password_resets (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES public.dashboard_users(id) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL UNIQUE,
        email        TEXT NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        used_at      TIMESTAMPTZ,
        requested_ip TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

-- 'invite' links live for days, 'reset' links for an hour.
SELECT pg_temp.ensure_column('password_resets', 'purpose', 'TEXT NOT NULL DEFAULT ''reset''');

SELECT pg_temp.ensure_check('password_resets', 'password_resets_purpose_check',
  'purpose IN (''reset'', ''invite'')');

SELECT pg_temp.ensure_index('idx_password_resets_user',
  $ddl$CREATE INDEX idx_password_resets_user ON public.password_resets (user_id)$ddl$);
SELECT pg_temp.ensure_index('idx_password_resets_expiry',
  $ddl$CREATE INDEX idx_password_resets_expiry ON public.password_resets (expires_at)$ddl$);
SELECT pg_temp.ensure_index('idx_password_resets_purpose',
  $ddl$CREATE INDEX idx_password_resets_purpose ON public.password_resets (user_id, purpose) WHERE used_at IS NULL$ddl$);

SELECT pg_temp.ensure_comment('password_resets', NULL,
  'Outstanding password reset links; token_hash is SHA-256 of the emailed token');
SELECT pg_temp.ensure_comment('password_resets', 'purpose',
  'reset = the account asked; invite = an administrator created the account');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_check(text, text, text);
DROP FUNCTION pg_temp.ensure_unique_index(text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
