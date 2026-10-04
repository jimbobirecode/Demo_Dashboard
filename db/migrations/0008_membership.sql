-- Membership: enquiry -> instant tailored reply -> guided application ->
-- club review -> welcome to the club.
--
-- The club switches the service on and off (club_settings.membership_enabled).
-- On, an enquiry to the club's membership address is answered with the
-- membership categories and a signed "Apply now" link; off, with a signed
-- "Join the waitlist" link. The core API writes enquiries and submitted forms
-- into these tables; the dashboard reviews them and emails the applicant at
-- each decision. The core API only reads and writes rows here and tolerates
-- the tables being absent.
--
-- Shared contract with the core API: the column set below is fixed by it, so
-- a change here is a change on both sides.

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

CREATE OR REPLACE FUNCTION pg_temp.ensure_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    EXECUTE ddl;
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

-- ---------------------------------------------------------------------------
-- club_settings: one row per club. membership_enabled is the owner's toggle;
-- membership_settings holds the copy the replies use
-- ({intro, next_steps, closed_message, contact_email, committee_name}).
-- No row reads as "membership off".
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.club_settings') IS NULL THEN
    CREATE TABLE public.club_settings (
        club                 TEXT PRIMARY KEY,
        membership_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
        membership_settings  JSONB   NOT NULL DEFAULT '{}'::jsonb,  -- {closed_message, intro, next_steps, contact_email, committee_name}
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by           TEXT
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- membership_categories: what the club offers, with its fees (club currency).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.membership_categories') IS NULL THEN
    CREATE TABLE public.membership_categories (
        id            SERIAL PRIMARY KEY,
        club          TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        eligibility   TEXT NOT NULL DEFAULT '',
        joining_fee   NUMERIC(10,2) NOT NULL DEFAULT 0,
        annual_fee    NUMERIC(10,2) NOT NULL DEFAULT 0,
        min_age       INTEGER,
        max_age       INTEGER,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (club, name)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- membership_applications: one per enquirer and club, from the first email to
-- the welcome. `reference` (MEM-YYYYMMDD-XXXXXXXX) is what the signed links
-- carry.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.membership_applications') IS NULL THEN
    CREATE TABLE public.membership_applications (
        id               SERIAL PRIMARY KEY,
        club             TEXT NOT NULL,
        reference        TEXT NOT NULL UNIQUE,
        kind             TEXT NOT NULL DEFAULT 'application' CHECK (kind IN ('application','waitlist')),
        status           TEXT NOT NULL DEFAULT 'enquired' CHECK (status IN ('enquired','submitted','under_review','approved','declined','welcomed','waitlisted','invited','withdrawn')),
        category_id      INTEGER REFERENCES public.membership_categories(id) ON DELETE SET NULL,
        first_name       TEXT,
        last_name        TEXT,
        email            TEXT NOT NULL,
        phone            TEXT,
        date_of_birth    DATE,
        address          TEXT,
        handicap         TEXT,
        home_club        TEXT,
        proposer         TEXT,
        seconder         TEXT,
        message          TEXT,             -- applicant's own words on the form
        enquiry_summary  TEXT,             -- short summary of the enquiry email (escaped on display)
        recommended_category_ids INTEGER[] NOT NULL DEFAULT '{}',
        consent          BOOLEAN NOT NULL DEFAULT FALSE,
        source_message_id INTEGER,         -- email_messages.id of the enquiry, when logged
        staff_notes      TEXT,
        decision_note    TEXT,
        decided_by       TEXT,
        decided_at       TIMESTAMPTZ,
        submitted_at     TIMESTAMPTZ,
        welcomed_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

SELECT pg_temp.ensure_index('idx_membership_applications_club_status',
  $ddl$CREATE INDEX idx_membership_applications_club_status ON public.membership_applications (club, status, created_at DESC)$ddl$);
SELECT pg_temp.ensure_index('idx_membership_applications_club_email',
  $ddl$CREATE INDEX idx_membership_applications_club_email ON public.membership_applications (club, lower(email))$ddl$);

-- ---------------------------------------------------------------------------
-- membership_events: the application's timeline. event is 'enquired',
-- 'link_sent', 'submitted', 'waitlisted', 'status:<new>', 'note',
-- 'email:<kind>' or 'invited'; actor is 'guest', 'bot' or a staff username.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.membership_events') IS NULL THEN
    CREATE TABLE public.membership_events (
        id              SERIAL PRIMARY KEY,
        application_id  INTEGER NOT NULL REFERENCES public.membership_applications(id) ON DELETE CASCADE,
        club            TEXT NOT NULL,
        event           TEXT NOT NULL,
        actor           TEXT NOT NULL,
        note            TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

SELECT pg_temp.ensure_index('idx_membership_events_app',
  $ddl$CREATE INDEX idx_membership_events_app ON public.membership_events (application_id, created_at)$ddl$);

SELECT pg_temp.ensure_comment('club_settings', NULL,
  'Per-club service switches; membership_enabled = applications accepted, otherwise enquiries are offered the waitlist');
SELECT pg_temp.ensure_comment('membership_categories', NULL,
  'Membership categories a club offers, with joining and annual fees in the club currency');
SELECT pg_temp.ensure_comment('membership_applications', NULL,
  'Membership enquiries, applications and waitlist entries, enquiry to welcome; reference is carried by signed links');
SELECT pg_temp.ensure_comment('membership_events', NULL,
  'Timeline of a membership application: status changes, emails, notes');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.has_column(text, text);
