-- Baseline, part 2: dashboard accounts, roles, sessions and reset links.
--
-- Folds in the dashboard_users table (previously created by the demo seed and
-- migration_upgrade_existing_db.sql), migration_add_password_reset.sql,
-- migration_add_user_management.sql and migration_add_session_version.sql.
-- Idempotent; one-off backfills run only when their column is created.

CREATE TABLE IF NOT EXISTS public.dashboard_users (
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

-- Where reset links go. When the column is introduced, accounts whose
-- username is already an address get it copied across (the API falls back to
-- the username anyway; this only makes it explicit).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dashboard_users' AND column_name = 'email'
  ) THEN
    ALTER TABLE public.dashboard_users ADD COLUMN email TEXT;
    UPDATE public.dashboard_users SET email = username WHERE username LIKE '%@%.%';
  END IF;
END $$;

COMMENT ON COLUMN public.dashboard_users.email IS
  'Address password reset links are sent to; falls back to username when it is an email address';

-- What an account may do: 'admin' can manage other accounts, 'staff' is
-- everything else. When roles are introduced every existing account becomes
-- an admin — before roles they could already do everything, and locking the
-- club out of its own dashboard on upgrade day would be worse. New accounts
-- default to 'staff'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dashboard_users' AND column_name = 'role'
  ) THEN
    ALTER TABLE public.dashboard_users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';
    UPDATE public.dashboard_users SET role = 'admin';
  END IF;
END $$;

ALTER TABLE public.dashboard_users
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS created_by TEXT,
    ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ,
    -- Bumped to end every outstanding session for the account.
    ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.dashboard_users.role IS
  'admin = may manage other accounts; staff = everything else';
COMMENT ON COLUMN public.dashboard_users.invited_at IS
  'When an invitation was last emailed. Whether it has been accepted is read from password_hash, not from here';
COMMENT ON COLUMN public.dashboard_users.session_version IS
  'Bumped to end every outstanding session for this account; sessions carry the value they were issued with';

DO $$
BEGIN
  ALTER TABLE public.dashboard_users
    ADD CONSTRAINT dashboard_users_role_check CHECK (role IN ('admin', 'staff'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One account per address, and one per login spelled in any case: logins are
-- matched case-insensitively.
--
-- A database already holding duplicates cannot take the index. That is
-- reported (the migration runner logs the warning) rather than allowed to stop
-- the dashboard booting; resolve the duplicate by hand and add the index with
-- a new migration.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_users_email
    ON public.dashboard_users (LOWER(email)) WHERE email IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'dashboard_users holds two accounts with the same email address; '
                'idx_dashboard_users_email was not created.';
END $$;

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_users_username
    ON public.dashboard_users (LOWER(username));
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'dashboard_users holds two accounts whose usernames differ only by case; '
                'idx_dashboard_users_username was not created.';
END $$;

-- ---------------------------------------------------------------------------
-- password_resets: outstanding reset links and invitations. Only the SHA-256
-- of a token is stored, so a leaked database cannot take over an account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.password_resets (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES public.dashboard_users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    email        TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    requested_ip TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 'invite' links live for days, 'reset' links for an hour.
ALTER TABLE public.password_resets
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'reset';

DO $$
BEGIN
  ALTER TABLE public.password_resets
    ADD CONSTRAINT password_resets_purpose_check CHECK (purpose IN ('reset', 'invite'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON public.password_resets (user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_expiry ON public.password_resets (expires_at);
CREATE INDEX IF NOT EXISTS idx_password_resets_purpose
    ON public.password_resets (user_id, purpose) WHERE used_at IS NULL;

COMMENT ON TABLE public.password_resets IS 'Outstanding password reset links; token_hash is SHA-256 of the emailed token';
COMMENT ON COLUMN public.password_resets.purpose IS
  'reset = the account asked; invite = an administrator created the account';
