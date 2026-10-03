-- Baseline, part 4: guest change requests and the email log / Inbox.
--
-- Folds in migration_add_change_requests.sql and migration_add_email_inbox.sql.
-- Both tables are written by the core API as well as the dashboard.


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

-- ---------------------------------------------------------------------------
-- booking_change_requests: amendments and cancellations a guest asked for.
-- The manage link itself is stateless (an HMAC of the booking reference), so
-- only the requests are stored.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.booking_change_requests') IS NULL THEN
    CREATE TABLE public.booking_change_requests (
        id                SERIAL PRIMARY KEY,
        booking_id        TEXT NOT NULL,
        club              TEXT NOT NULL,

        -- 'cancel' or 'amend'. An amend carries what they want in `message`.
        kind              TEXT NOT NULL,
        message           TEXT,

        -- What they asked to move to, where they said. All optional.
        requested_date    DATE,
        requested_time    TEXT,
        requested_players INTEGER,

        status            TEXT NOT NULL DEFAULT 'Pending',
        -- Recorded at the moment of the request, so a later policy change cannot
        -- rewrite what the guest was told at the time.
        auto_applied      BOOLEAN NOT NULL DEFAULT FALSE,
        days_before_play  INTEGER,

        resolved_at       TIMESTAMPTZ,
        resolved_by       TEXT,
        resolution_note   TEXT,

        guest_email       TEXT,
        requested_ip      TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

SELECT pg_temp.ensure_check('booking_change_requests', 'booking_change_requests_kind_check',
  'kind IN (''cancel'', ''amend'')');

SELECT pg_temp.ensure_check('booking_change_requests', 'booking_change_requests_status_check',
  'status IN (''Pending'', ''Approved'', ''Declined'', ''Applied'')');

-- Change requests that arrived by email rather than through the manage link.
SELECT pg_temp.ensure_column('booking_change_requests', 'source', 'TEXT NOT NULL DEFAULT ''link''');
SELECT pg_temp.ensure_column('booking_change_requests', 'email_message_id', 'INTEGER');

SELECT pg_temp.ensure_index('idx_change_requests_booking',
  $ddl$CREATE INDEX idx_change_requests_booking ON public.booking_change_requests (booking_id)$ddl$);
SELECT pg_temp.ensure_index('idx_change_requests_open',
  $ddl$CREATE INDEX idx_change_requests_open ON public.booking_change_requests (club, status) WHERE status = 'Pending'$ddl$);

SELECT pg_temp.ensure_comment('booking_change_requests', NULL,
  'Amendments and cancellations asked for by the guest; the club approves unless policy auto-applies');
SELECT pg_temp.ensure_comment('booking_change_requests', 'auto_applied',
  'True where club policy let the change take effect without staff approval');
SELECT pg_temp.ensure_comment('booking_change_requests', 'source',
  'link (manage page) or email (read from a guest email)');

-- ---------------------------------------------------------------------------
-- email_messages: every guest email in and out. review_status = 'open' is the
-- dashboard Inbox.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.email_messages') IS NULL THEN
    CREATE TABLE public.email_messages (
        id                SERIAL PRIMARY KEY,
        club              TEXT NOT NULL,
        direction         TEXT NOT NULL,             -- 'inbound' | 'outbound'
        booking_id        TEXT,

        from_email        TEXT,
        to_email          TEXT,
        subject           TEXT,
        body_text         TEXT,

        -- What an inbound email was understood to be.
        intent            TEXT,                      -- new_enquiry, booking_reply, change_request, cancellation, question, complaint, operator_request, not_booking, other
        summary           TEXT,
        extraction        JSONB,

        -- Where it went.
        routed_to         TEXT,                      -- auto_reply, booking_request, inbox, change_request, ignored
        change_request_id INTEGER,

        -- The Inbox: open until somebody replies or dismisses it.
        review_status     TEXT NOT NULL DEFAULT 'none', -- none | open | replied | dismissed
        review_reason     TEXT,
        draft_reply       TEXT,
        handled_at        TIMESTAMPTZ,
        handled_by        TEXT,

        -- Outbound: who sent it ('bot', 'Stripe', or a dashboard username) and what
        -- kind of email it was.
        sent_by           TEXT,
        kind              TEXT,                      -- availability, acknowledgement, payment_link, receipt, pre_arrival, post_play, reply, ...
        in_reply_to       INTEGER REFERENCES public.email_messages(id) ON DELETE SET NULL,

        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

SELECT pg_temp.ensure_index('idx_email_messages_booking',
  $ddl$CREATE INDEX idx_email_messages_booking ON public.email_messages (club, booking_id, created_at)$ddl$);
SELECT pg_temp.ensure_index('idx_email_messages_inbox',
  $ddl$CREATE INDEX idx_email_messages_inbox ON public.email_messages (club, review_status, created_at) WHERE review_status = 'open'$ddl$);
SELECT pg_temp.ensure_index('idx_email_messages_from',
  $ddl$CREATE INDEX idx_email_messages_from ON public.email_messages (club, lower(from_email))$ddl$);

SELECT pg_temp.ensure_comment('email_messages', NULL,
  'Every guest email in and out; review_status = open is the dashboard Inbox');

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_check(text, text, text);
DROP FUNCTION pg_temp.ensure_unique_index(text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
