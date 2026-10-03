-- Revocable staff sessions.
--
-- A staff session is a signed cookie that carries the account's
-- session_version from when it was issued. The dashboard compares it with this
-- column on every request (briefly cached), so bumping the number ends every
-- session the account holds — on sign-out, a password change or reset,
-- deactivation, a role change or deletion.
--
-- Safe to run more than once, and safe against a live database: the column is
-- additive and the dashboard detects it at runtime. Until it is run, sessions
-- are still checked against the account (active, same club, current role) on
-- every request; only "sign out everywhere" waits for this column.

ALTER TABLE public.dashboard_users
  ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.dashboard_users.session_version IS
  'Bumped to end every outstanding session for this account; sessions carry the value they were issued with';

SELECT 'Session version migration complete' AS status,
       COUNT(*) AS users
  FROM public.dashboard_users;
