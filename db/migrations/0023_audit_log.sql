-- The audit trail: who changed what, when, and from where.
--
-- Until now the dashboard kept only a last-writer stamp (`updated_by`,
-- `updated_at`) on each row, which answers "who touched this last" and
-- nothing else: not what it was before, not what was deleted, not who tried
-- and was refused. This table is the record an auditor asks for, and the one
-- the club needs the day a booking's price or an operator's credit terms are
-- not what somebody remembers agreeing.
--
-- Written by the dashboard for EVERY state-changing request (see
-- server/src/lib/audit.js), so a route added later is covered without anybody
-- remembering to instrument it.
--
-- Retention is 12 months, enforced nightly in the server (auditPurge). The
-- rows name staff and carry request bodies, so keeping them forever would be
-- holding personal data with no purpose to point at.

CREATE OR REPLACE FUNCTION pg_temp.ensure_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    EXECUTE ddl;
  END IF;
END $$;

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
  IF to_regclass('public.audit_log') IS NULL THEN
    CREATE TABLE public.audit_log (
        id          BIGSERIAL PRIMARY KEY,
        club        TEXT        NOT NULL,
        at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Who. `actor` is the staff username, the operator's address, or the
        -- name of the machine that acted ('Stripe', 'bot'); `actor_kind`
        -- tells those apart without having to recognise the value.
        actor       TEXT,
        actor_kind  TEXT        NOT NULL DEFAULT 'staff',
        actor_role  TEXT,

        -- What. `action` is a dotted name the screen groups by
        -- ('booking.payment.update'); `entity_type`/`entity_id` are what it
        -- was done to, so one booking's whole history is a single index scan.
        action      TEXT        NOT NULL,
        entity_type TEXT,
        entity_id   TEXT,
        summary     TEXT,

        -- How it went: 'applied' (the change happened), 'refused' (rejected,
        -- including a 403 — an attempt is worth keeping) or 'failed'.
        outcome     TEXT        NOT NULL DEFAULT 'applied',
        status      INTEGER,
        method      TEXT,
        path        TEXT,

        -- The request as it arrived, with every secret redacted
        -- (server/src/lib/audit.js REDACTED). Never a password, token or key.
        details     JSONB,

        ip          TEXT,
        user_agent  TEXT
    );
  END IF;
END $$;

-- The three ways it is read: the page (newest first), one record's history,
-- and one person's activity.
SELECT pg_temp.ensure_index('idx_audit_log_club_at',
  $ddl$CREATE INDEX idx_audit_log_club_at ON public.audit_log (club, at DESC)$ddl$);
SELECT pg_temp.ensure_index('idx_audit_log_entity',
  $ddl$CREATE INDEX idx_audit_log_entity ON public.audit_log (club, entity_type, entity_id, at DESC)$ddl$);
SELECT pg_temp.ensure_index('idx_audit_log_actor',
  $ddl$CREATE INDEX idx_audit_log_actor ON public.audit_log (club, actor, at DESC)$ddl$);
-- The nightly purge deletes by age across every club at once.
SELECT pg_temp.ensure_index('idx_audit_log_at',
  $ddl$CREATE INDEX idx_audit_log_at ON public.audit_log (at)$ddl$);

SELECT pg_temp.ensure_comment('audit_log', NULL,
  'Every state-changing request: who, what, when, from where. Written by the dashboard, kept 12 months.');
SELECT pg_temp.ensure_comment('audit_log', 'details',
  'The request as it arrived, with secrets redacted. Never a password, token or key.');
SELECT pg_temp.ensure_comment('audit_log', 'outcome',
  'applied (the change happened), refused (rejected, including a 403) or failed');

DROP FUNCTION IF EXISTS pg_temp.ensure_index(text, text);
DROP FUNCTION IF EXISTS pg_temp.ensure_comment(text, text, text);
