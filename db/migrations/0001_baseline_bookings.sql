-- Baseline, part 1: bookings and the tables that hang off a booking.
--
-- Reproduces the schema the dashboard and the core API were running on when
-- versioned migrations were introduced, folding in what used to be spread
-- across seed_royal_dornoch_demo.sql, migration_upgrade_existing_db.sql,
-- migration_add_hotel_and_workflow.sql, migration_add_journey_emails.sql,
-- migration_add_resort_fees.sql, migration_add_booking_source.sql,
-- migration_add_stripe_payment_links.sql, migration_add_payment_receipts.sql,
-- migration_add_tour_operators.sql, migration_add_waitlist_conversion.sql and
-- the core API's booking-form, resort-fee, offered-tee-times and tee-sheet
-- DDL.
--
-- Every statement is idempotent: on a database that already has this schema
-- the file changes nothing. Columns are added in the order production gained
-- them, so a fresh database and an upgraded one dump identically.
--
-- One-off data backfills are tied to the moment their column is created (see
-- the DO blocks), so they run exactly once on any database and never rewrite
-- data on one that already had the column.


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
-- bookings
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.bookings') IS NULL THEN
    CREATE TABLE public.bookings (
        id                        SERIAL PRIMARY KEY,
        booking_id                VARCHAR(255) UNIQUE,
        guest_email               VARCHAR(255),
        guest_name                VARCHAR(255),
        date                      DATE,
        tee_time                  VARCHAR(50),
        players                   INTEGER,
        total                     DECIMAL(10,2),
        status                    VARCHAR(50),
        note                      TEXT,
        club                      VARCHAR(255),
        timestamp                 TIMESTAMP DEFAULT NOW(),
        customer_confirmed_at     TIMESTAMP,
        updated_at                TIMESTAMP,
        updated_by                VARCHAR(255),
        created_at                TIMESTAMP DEFAULT NOW(),
        hotel_required            BOOLEAN DEFAULT FALSE,
        hotel_checkin             DATE,
        hotel_checkout            DATE,
        hotel_nights              INTEGER,
        hotel_rooms               INTEGER,
        hotel_cost                DECIMAL(10,2),
        lodging_intent            TEXT,
        lodging_nights            INTEGER,
        lodging_rooms             INTEGER,
        lodging_room_type         VARCHAR(100),
        lodging_preferences       TEXT,
        lodging_cost              DECIMAL(10,2),
        resort_fee_per_person     DECIMAL(10,2) DEFAULT 0.00,
        resort_fee_total          DECIMAL(10,2) DEFAULT 0.00,
        golf_dates                TEXT[],
        golf_courses              TEXT,
        selected_tee_times        JSONB,
        pre_arrival_email_sent_at TIMESTAMPTZ,
        post_play_email_sent_at   TIMESTAMPTZ
    );
  END IF;
END $$;

-- Older installs predate some of the columns above.
SELECT pg_temp.ensure_column('bookings', 'guest_name', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('bookings', 'customer_confirmed_at', 'TIMESTAMP');
SELECT pg_temp.ensure_column('bookings', 'updated_at', 'TIMESTAMP');
SELECT pg_temp.ensure_column('bookings', 'updated_by', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('bookings', 'hotel_required', 'BOOLEAN DEFAULT FALSE');
SELECT pg_temp.ensure_column('bookings', 'hotel_checkin', 'DATE');
SELECT pg_temp.ensure_column('bookings', 'hotel_checkout', 'DATE');
SELECT pg_temp.ensure_column('bookings', 'hotel_nights', 'INTEGER');
SELECT pg_temp.ensure_column('bookings', 'hotel_rooms', 'INTEGER');
SELECT pg_temp.ensure_column('bookings', 'hotel_cost', 'DECIMAL(10,2)');
SELECT pg_temp.ensure_column('bookings', 'lodging_intent', 'TEXT');
SELECT pg_temp.ensure_column('bookings', 'lodging_nights', 'INTEGER');
SELECT pg_temp.ensure_column('bookings', 'lodging_rooms', 'INTEGER');
SELECT pg_temp.ensure_column('bookings', 'lodging_room_type', 'VARCHAR(100)');
SELECT pg_temp.ensure_column('bookings', 'lodging_preferences', 'TEXT');
SELECT pg_temp.ensure_column('bookings', 'lodging_cost', 'DECIMAL(10,2)');
SELECT pg_temp.ensure_column('bookings', 'resort_fee_per_person', 'DECIMAL(10,2) DEFAULT 0.00');
SELECT pg_temp.ensure_column('bookings', 'resort_fee_total', 'DECIMAL(10,2) DEFAULT 0.00');
SELECT pg_temp.ensure_column('bookings', 'golf_dates', 'TEXT[]');
SELECT pg_temp.ensure_column('bookings', 'golf_courses', 'TEXT');
SELECT pg_temp.ensure_column('bookings', 'selected_tee_times', 'JSONB');
SELECT pg_temp.ensure_column('bookings', 'pre_arrival_email_sent_at', 'TIMESTAMPTZ');
SELECT pg_temp.ensure_column('bookings', 'post_play_email_sent_at', 'TIMESTAMPTZ');

SELECT pg_temp.ensure_comment('bookings', 'guest_name',
  'Guest name for personalized emails');
SELECT pg_temp.ensure_comment('bookings', 'hotel_checkin',
  'Hotel check-in date');
SELECT pg_temp.ensure_comment('bookings', 'hotel_checkout',
  'Hotel check-out date');
SELECT pg_temp.ensure_comment('bookings', 'hotel_nights',
  'Number of hotel nights');
SELECT pg_temp.ensure_comment('bookings', 'hotel_rooms',
  'Number of hotel rooms needed');
SELECT pg_temp.ensure_comment('bookings', 'hotel_cost',
  'Estimated hotel cost');
SELECT pg_temp.ensure_comment('bookings', 'lodging_intent',
  'Lodging intent/confidence from email parsing');
SELECT pg_temp.ensure_comment('bookings', 'golf_dates',
  'Array of golf play dates');
SELECT pg_temp.ensure_comment('bookings', 'golf_courses',
  'Golf courses requested/booked');
SELECT pg_temp.ensure_comment('bookings', 'selected_tee_times',
  'JSON of selected tee times with details');
SELECT pg_temp.ensure_comment('bookings', 'pre_arrival_email_sent_at',
  'Timestamp when welcome email was sent (3 days before play)');
SELECT pg_temp.ensure_comment('bookings', 'post_play_email_sent_at',
  'Timestamp when thank you email was sent (2 days after play)');
SELECT pg_temp.ensure_comment('bookings', 'resort_fee_per_person',
  'Resort fee charged per person per night');
SELECT pg_temp.ensure_comment('bookings', 'resort_fee_total',
  'Total resort fees charged for bookings with lodging');

-- The core API's hosted booking form (/book).
SELECT pg_temp.ensure_column('bookings', 'contact_phone', 'VARCHAR(50)');
SELECT pg_temp.ensure_column('bookings', 'caddie_requirements', 'VARCHAR(100)');
SELECT pg_temp.ensure_column('bookings', 'special_requests', 'TEXT');
SELECT pg_temp.ensure_column('bookings', 'form_submitted_at', 'TIMESTAMP');

SELECT pg_temp.ensure_comment('bookings', 'contact_phone',
  'Lead guest phone number from the booking form');
SELECT pg_temp.ensure_comment('bookings', 'caddie_requirements',
  'Caddie preference chosen on the booking form');
SELECT pg_temp.ensure_comment('bookings', 'special_requests',
  'Handicaps and free-text requests from the booking form');
SELECT pg_temp.ensure_comment('bookings', 'form_submitted_at',
  'When the guest submitted the booking form');

-- Where a booking came from: the enquiry pipeline, or an uploaded tee sheet.
-- Without the marker an import would be counted as enquiries TeeMail
-- converted. The column is NOT NULL with a default, so existing rows read
-- 'teemail' the moment it is added.
SELECT pg_temp.ensure_column('bookings', 'source', 'TEXT NOT NULL DEFAULT ''teemail''');
SELECT pg_temp.ensure_column('bookings', 'import_batch', 'TEXT');
SELECT pg_temp.ensure_column('bookings', 'imported_at', 'TIMESTAMPTZ');

SELECT pg_temp.ensure_comment('bookings', 'source',
  'teemail = came through the enquiry pipeline; imported = uploaded from the club''s own tee sheet');
SELECT pg_temp.ensure_comment('bookings', 'import_batch',
  'The upload this row arrived on; NULL for anything TeeMail took itself');

SELECT pg_temp.ensure_check('bookings', 'bookings_source_check',
  'source IN (''teemail'', ''imported'')');

-- Stripe payment links emailed from the dashboard.
SELECT pg_temp.ensure_column('bookings', 'payment_status', 'VARCHAR(32) NOT NULL DEFAULT ''Unpaid''');
SELECT pg_temp.ensure_column('bookings', 'amount_paid', 'NUMERIC(10,2) NOT NULL DEFAULT 0');
SELECT pg_temp.ensure_column('bookings', 'stripe_payment_link_id', 'VARCHAR(64)');
SELECT pg_temp.ensure_column('bookings', 'stripe_payment_link_url', 'TEXT');
SELECT pg_temp.ensure_column('bookings', 'payment_link_amount', 'NUMERIC(10,2)');
SELECT pg_temp.ensure_column('bookings', 'payment_link_sent_at', 'TIMESTAMP WITH TIME ZONE');
SELECT pg_temp.ensure_column('bookings', 'payment_link_sent_by', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('bookings', 'stripe_checkout_session_id', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('bookings', 'stripe_paid_at', 'TIMESTAMP WITH TIME ZONE');

SELECT pg_temp.ensure_comment('bookings', 'payment_status',
  'Unpaid | Pending | Deposit paid | Paid | Refunded | Written off');
SELECT pg_temp.ensure_comment('bookings', 'amount_paid',
  'Money received against this booking so far');
SELECT pg_temp.ensure_comment('bookings', 'stripe_payment_link_id',
  'The Stripe Payment Link last emailed to the guest (plink_...)');
SELECT pg_temp.ensure_comment('bookings', 'stripe_payment_link_url',
  'Its URL, as the guest received it');
SELECT pg_temp.ensure_comment('bookings', 'payment_link_amount',
  'The amount that link asks for');
SELECT pg_temp.ensure_comment('bookings', 'payment_link_sent_at',
  'When the link was last emailed');
SELECT pg_temp.ensure_comment('bookings', 'stripe_checkout_session_id',
  'The last Stripe payment counted; stops a retried webhook counting it twice');
SELECT pg_temp.ensure_comment('bookings', 'stripe_paid_at',
  'When Stripe last reported a payment for this booking');

-- Payment receipts and the pre-play clock.
SELECT pg_temp.ensure_column('bookings', 'stripe_payment_intent_id', 'VARCHAR(255)');
SELECT pg_temp.ensure_column('bookings', 'stripe_last_payment_amount', 'NUMERIC(10,2)');
SELECT pg_temp.ensure_column('bookings', 'payment_receipt_sent_at', 'TIMESTAMP WITH TIME ZONE');

-- Bookings already paid when the clock was introduced have started theirs.
-- Tied to the column's creation so it runs once, and never again on a
-- database where the app has been managing the clock itself.
DO $$
BEGIN
  IF NOT pg_temp.has_column('bookings', 'pre_play_clock_started_at') THEN
    ALTER TABLE public.bookings ADD COLUMN pre_play_clock_started_at TIMESTAMP WITH TIME ZONE;
    UPDATE public.bookings
       SET pre_play_clock_started_at = COALESCE(stripe_paid_at, NOW())
     WHERE payment_status IN ('Paid', 'Deposit paid');
  END IF;
END $$;

SELECT pg_temp.ensure_comment('bookings', 'stripe_payment_intent_id',
  'Stripe reference (pi_...) of the last payment, quoted on the receipt');
SELECT pg_temp.ensure_comment('bookings', 'stripe_last_payment_amount',
  'What the last Stripe payment was for, so its receipt can be resent');
SELECT pg_temp.ensure_comment('bookings', 'payment_receipt_sent_at',
  'When the receipt for the last payment was emailed; NULL means it has not been');
SELECT pg_temp.ensure_comment('bookings', 'pre_play_clock_started_at',
  'When payment started the pre-play email sequence');

-- ---------------------------------------------------------------------------
-- tour_operators, and the trade half of a booking
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.tour_operators') IS NULL THEN
    CREATE TABLE public.tour_operators (
        id                  SERIAL PRIMARY KEY,
        club                VARCHAR(100) NOT NULL,
        name                VARCHAR(255) NOT NULL,

        contact_name        VARCHAR(255),
        contact_email       VARCHAR(255),
        contact_phone       VARCHAR(64),
        account_code        VARCHAR(64),

        -- How a booking is recognised as this operator's without anybody tagging
        -- it: the email domains they book from, e.g. {"golfbreaks.com"}.
        email_domains       TEXT[] NOT NULL DEFAULT '{}',

        -- Credit terms.
        payment_terms_days             INTEGER NOT NULL DEFAULT 30,
        deposit_percent                NUMERIC(5,2) NOT NULL DEFAULT 0,
        deposit_due_days_before_play   INTEGER,
        balance_due_days_before_play   INTEGER,
        credit_limit        NUMERIC(12,2),
        currency            VARCHAR(3) NOT NULL DEFAULT 'GBP',

        -- `on_hold`: no new business until the account is settled. `active`
        -- retires an operator without deleting their history.
        on_hold             BOOLEAN NOT NULL DEFAULT FALSE,
        active              BOOLEAN NOT NULL DEFAULT TRUE,

        notes               TEXT,
        created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_by          VARCHAR(255)
    );
  END IF;
END $$;

-- One name per club, case-insensitively.
SELECT pg_temp.ensure_unique_index('idx_tour_operators_club_name',
  $ddl$CREATE UNIQUE INDEX idx_tour_operators_club_name ON public.tour_operators (club, LOWER(name))$ddl$);
SELECT pg_temp.ensure_index('idx_tour_operators_club',
  $ddl$CREATE INDEX idx_tour_operators_club ON public.tour_operators (club)$ddl$);

SELECT pg_temp.ensure_comment('tour_operators', NULL,
  'Trade partners who book on behalf of guests, and the credit they trade on');
SELECT pg_temp.ensure_comment('tour_operators', 'email_domains',
  'Sending domains that identify a booking as this operator''s');
SELECT pg_temp.ensure_comment('tour_operators', 'payment_terms_days',
  'Net days from invoice date; 0 means payment on invoice');
SELECT pg_temp.ensure_comment('tour_operators', 'deposit_percent',
  'Share of the booking total due as a deposit, 0-100');
SELECT pg_temp.ensure_comment('tour_operators', 'deposit_due_days_before_play',
  'Deposit due this many days before play; NULL falls back to the invoice terms');
SELECT pg_temp.ensure_comment('tour_operators', 'balance_due_days_before_play',
  'Balance due this many days before play; NULL falls back to the invoice terms');
SELECT pg_temp.ensure_comment('tour_operators', 'credit_limit',
  'Maximum outstanding balance allowed on the account; NULL means no limit');
SELECT pg_temp.ensure_comment('tour_operators', 'on_hold',
  'Account suspended — take no new business until it is settled');

SELECT pg_temp.ensure_column('bookings', 'tour_operator_id', 'INTEGER REFERENCES public.tour_operators(id) ON DELETE SET NULL');
SELECT pg_temp.ensure_column('bookings', 'invoice_number', 'VARCHAR(64)');
SELECT pg_temp.ensure_column('bookings', 'invoiced_at', 'DATE');
SELECT pg_temp.ensure_column('bookings', 'deposit_due_date', 'DATE');
SELECT pg_temp.ensure_column('bookings', 'balance_due_date', 'DATE');
-- Operator reminder send stamps, so a reminder is not sent twice.
SELECT pg_temp.ensure_column('bookings', 'operator_status_email_sent_at', 'TIMESTAMP WITH TIME ZONE');
SELECT pg_temp.ensure_column('bookings', 'operator_payment_email_sent_at', 'TIMESTAMP WITH TIME ZONE');

SELECT pg_temp.ensure_comment('bookings', 'tour_operator_id',
  'The trade account this booking belongs to; NULL is a direct guest booking');
SELECT pg_temp.ensure_comment('bookings', 'deposit_due_date',
  'Overrides the date derived from the operator''s credit terms');
SELECT pg_temp.ensure_comment('bookings', 'balance_due_date',
  'Overrides the date derived from the operator''s credit terms');
SELECT pg_temp.ensure_comment('bookings', 'operator_status_email_sent_at',
  'When this booking was last included in a booking-status reminder to its operator');
SELECT pg_temp.ensure_comment('bookings', 'operator_payment_email_sent_at',
  'When this booking was last included in a payment reminder to its operator');

-- The tee times an availability email offered (written by the core API), so
-- the booking form can accept those and nothing else.
SELECT pg_temp.ensure_column('bookings', 'offered_tee_times', 'JSONB');

-- ---------------------------------------------------------------------------
-- bookings indexes
-- ---------------------------------------------------------------------------
SELECT pg_temp.ensure_index('idx_bookings_club_status',
  $ddl$CREATE INDEX idx_bookings_club_status ON public.bookings (club, status)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_club_date',
  $ddl$CREATE INDEX idx_bookings_club_date ON public.bookings (club, date)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_status',
  $ddl$CREATE INDEX idx_bookings_status ON public.bookings (status)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_hotel_checkin',
  $ddl$CREATE INDEX idx_bookings_hotel_checkin ON public.bookings (hotel_checkin)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_pre_arrival_email',
  $ddl$CREATE INDEX idx_bookings_pre_arrival_email ON public.bookings (pre_arrival_email_sent_at)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_post_play_email',
  $ddl$CREATE INDEX idx_bookings_post_play_email ON public.bookings (post_play_email_sent_at)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_play_date_status',
  $ddl$CREATE INDEX idx_bookings_play_date_status ON public.bookings (date, status)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_source',
  $ddl$CREATE INDEX idx_bookings_source ON public.bookings (club, source)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_import_batch',
  $ddl$CREATE INDEX idx_bookings_import_batch ON public.bookings (import_batch) WHERE import_batch IS NOT NULL$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_stripe_payment_link',
  $ddl$CREATE INDEX idx_bookings_stripe_payment_link ON public.bookings (stripe_payment_link_id)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_tour_operator',
  $ddl$CREATE INDEX idx_bookings_tour_operator ON public.bookings (tour_operator_id)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_payment_status',
  $ddl$CREATE INDEX idx_bookings_payment_status ON public.bookings (payment_status)$ddl$);
SELECT pg_temp.ensure_index('idx_bookings_balance_due',
  $ddl$CREATE INDEX idx_bookings_balance_due ON public.bookings (balance_due_date)$ddl$);

-- ---------------------------------------------------------------------------
-- waitlist
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.waitlist') IS NULL THEN
    CREATE TABLE public.waitlist (
        id                   SERIAL PRIMARY KEY,
        waitlist_id          VARCHAR(50) UNIQUE NOT NULL,
        guest_email          VARCHAR(255) NOT NULL,
        guest_name           VARCHAR(255),
        requested_date       DATE NOT NULL,
        preferred_time       VARCHAR(50),
        time_flexibility     VARCHAR(50),
        players              INTEGER DEFAULT 1,
        golf_course          VARCHAR(100),
        status               VARCHAR(50) DEFAULT 'Waiting',
        priority             INTEGER DEFAULT 5,
        notes                TEXT,
        notification_sent    BOOLEAN DEFAULT FALSE,
        notification_sent_at TIMESTAMP,
        created_at           TIMESTAMP DEFAULT NOW(),
        updated_at           TIMESTAMP DEFAULT NOW(),
        club                 VARCHAR(100)
    );
  END IF;
END $$;

-- Which booking an entry became, and when. When the link is introduced, the
-- conversions the Streamlit dashboard recorded only in prose ("Converted from
-- waitlist: WL-0001.") are recovered from the booking notes.
DO $$
BEGIN
  IF NOT pg_temp.has_column('waitlist', 'converted_booking_id') THEN
    ALTER TABLE public.waitlist
      ADD COLUMN converted_booking_id TEXT,
      ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

    UPDATE public.waitlist w
       SET converted_booking_id = b.booking_id,
           -- The note carries no timestamp; the booking's own is the closest
           -- honest answer, so time-to-convert for these rows is approximate.
           converted_at = COALESCE(w.converted_at, b.timestamp, NOW())
      FROM public.bookings b
     WHERE w.converted_booking_id IS NULL
       AND b.note ~ 'Converted from waitlist:'
       -- No '.' in the class: the note ends the sentence with one.
       AND w.waitlist_id = substring(b.note from 'Converted from waitlist:\s*([A-Za-z0-9_-]+)')
       AND (w.club IS NOT DISTINCT FROM b.club);

    UPDATE public.waitlist
       SET status = 'Converted'
     WHERE converted_booking_id IS NOT NULL AND status IS DISTINCT FROM 'Converted';
  END IF;
END $$;

SELECT pg_temp.ensure_column('waitlist', 'converted_at', 'TIMESTAMPTZ');

SELECT pg_temp.ensure_comment('waitlist', 'converted_booking_id',
  'bookings.booking_id this entry became; NULL until it converts');
SELECT pg_temp.ensure_comment('waitlist', 'converted_at',
  'When the conversion was recorded — the clock for time-to-convert');

SELECT pg_temp.ensure_index('idx_waitlist_club_date',
  $ddl$CREATE INDEX idx_waitlist_club_date ON public.waitlist (club, requested_date)$ddl$);
SELECT pg_temp.ensure_index('idx_waitlist_status',
  $ddl$CREATE INDEX idx_waitlist_status ON public.waitlist (club, status)$ddl$);
SELECT pg_temp.ensure_index('idx_waitlist_converted',
  $ddl$CREATE INDEX idx_waitlist_converted ON public.waitlist (converted_booking_id) WHERE converted_booking_id IS NOT NULL$ddl$);

-- ---------------------------------------------------------------------------
-- tee_times: the bookable sheet the core API quotes availability from. Rows
-- for a (club, course, date) override its simulated sheet for that day.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.tee_times') IS NULL THEN
    CREATE TABLE public.tee_times (
        id              SERIAL PRIMARY KEY,
        club            VARCHAR(100) NOT NULL,
        course          VARCHAR(100) NOT NULL,
        date            DATE NOT NULL,
        time            TIME NOT NULL,
        max_players     INTEGER DEFAULT 4,
        available_slots INTEGER DEFAULT 4,
        is_available    BOOLEAN DEFAULT TRUE,
        green_fee       DECIMAL(10,2),
        notes           TEXT,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE (club, course, date, time)
    );
  END IF;
END $$;

SELECT pg_temp.ensure_index('idx_tee_times_lookup',
  $ddl$CREATE INDEX idx_tee_times_lookup ON public.tee_times (club, course, date)$ddl$);

DROP FUNCTION pg_temp.ensure_comment(text, text, text);
DROP FUNCTION pg_temp.ensure_check(text, text, text);
DROP FUNCTION pg_temp.ensure_unique_index(text, text);
DROP FUNCTION pg_temp.ensure_index(text, text);
DROP FUNCTION pg_temp.ensure_column(text, text, text);
DROP FUNCTION pg_temp.has_column(text, text);
