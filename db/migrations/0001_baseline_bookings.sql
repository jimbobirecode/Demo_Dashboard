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
-- bookings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bookings (
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

-- Older installs predate some of the columns above.
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS guest_name                VARCHAR(255),
    ADD COLUMN IF NOT EXISTS customer_confirmed_at     TIMESTAMP,
    ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMP,
    ADD COLUMN IF NOT EXISTS updated_by                VARCHAR(255),
    ADD COLUMN IF NOT EXISTS hotel_required            BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS hotel_checkin             DATE,
    ADD COLUMN IF NOT EXISTS hotel_checkout            DATE,
    ADD COLUMN IF NOT EXISTS hotel_nights              INTEGER,
    ADD COLUMN IF NOT EXISTS hotel_rooms               INTEGER,
    ADD COLUMN IF NOT EXISTS hotel_cost                DECIMAL(10,2),
    ADD COLUMN IF NOT EXISTS lodging_intent            TEXT,
    ADD COLUMN IF NOT EXISTS lodging_nights            INTEGER,
    ADD COLUMN IF NOT EXISTS lodging_rooms             INTEGER,
    ADD COLUMN IF NOT EXISTS lodging_room_type         VARCHAR(100),
    ADD COLUMN IF NOT EXISTS lodging_preferences       TEXT,
    ADD COLUMN IF NOT EXISTS lodging_cost              DECIMAL(10,2),
    ADD COLUMN IF NOT EXISTS resort_fee_per_person     DECIMAL(10,2) DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS resort_fee_total          DECIMAL(10,2) DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS golf_dates                TEXT[],
    ADD COLUMN IF NOT EXISTS golf_courses              TEXT,
    ADD COLUMN IF NOT EXISTS selected_tee_times        JSONB,
    ADD COLUMN IF NOT EXISTS pre_arrival_email_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS post_play_email_sent_at   TIMESTAMPTZ;

COMMENT ON COLUMN public.bookings.guest_name IS 'Guest name for personalized emails';
COMMENT ON COLUMN public.bookings.hotel_checkin IS 'Hotel check-in date';
COMMENT ON COLUMN public.bookings.hotel_checkout IS 'Hotel check-out date';
COMMENT ON COLUMN public.bookings.hotel_nights IS 'Number of hotel nights';
COMMENT ON COLUMN public.bookings.hotel_rooms IS 'Number of hotel rooms needed';
COMMENT ON COLUMN public.bookings.hotel_cost IS 'Estimated hotel cost';
COMMENT ON COLUMN public.bookings.lodging_intent IS 'Lodging intent/confidence from email parsing';
COMMENT ON COLUMN public.bookings.golf_dates IS 'Array of golf play dates';
COMMENT ON COLUMN public.bookings.golf_courses IS 'Golf courses requested/booked';
COMMENT ON COLUMN public.bookings.selected_tee_times IS 'JSON of selected tee times with details';
COMMENT ON COLUMN public.bookings.pre_arrival_email_sent_at IS 'Timestamp when welcome email was sent (3 days before play)';
COMMENT ON COLUMN public.bookings.post_play_email_sent_at IS 'Timestamp when thank you email was sent (2 days after play)';
COMMENT ON COLUMN public.bookings.resort_fee_per_person IS 'Resort fee charged per person per night';
COMMENT ON COLUMN public.bookings.resort_fee_total IS 'Total resort fees charged for bookings with lodging';

-- The core API's hosted booking form (/book).
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS contact_phone       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS caddie_requirements VARCHAR(100),
    ADD COLUMN IF NOT EXISTS special_requests    TEXT,
    ADD COLUMN IF NOT EXISTS form_submitted_at   TIMESTAMP;

COMMENT ON COLUMN public.bookings.contact_phone IS 'Lead guest phone number from the booking form';
COMMENT ON COLUMN public.bookings.caddie_requirements IS 'Caddie preference chosen on the booking form';
COMMENT ON COLUMN public.bookings.special_requests IS 'Handicaps and free-text requests from the booking form';
COMMENT ON COLUMN public.bookings.form_submitted_at IS 'When the guest submitted the booking form';

-- Where a booking came from: the enquiry pipeline, or an uploaded tee sheet.
-- Without the marker an import would be counted as enquiries TeeMail
-- converted. The column is NOT NULL with a default, so existing rows read
-- 'teemail' the moment it is added.
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS source       TEXT NOT NULL DEFAULT 'teemail',
    ADD COLUMN IF NOT EXISTS import_batch TEXT,
    ADD COLUMN IF NOT EXISTS imported_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.bookings.source IS
  'teemail = came through the enquiry pipeline; imported = uploaded from the club''s own tee sheet';
COMMENT ON COLUMN public.bookings.import_batch IS
  'The upload this row arrived on; NULL for anything TeeMail took itself';

DO $$
BEGIN
  ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_source_check CHECK (source IN ('teemail', 'imported'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Stripe payment links emailed from the dashboard.
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS payment_status             VARCHAR(32) NOT NULL DEFAULT 'Unpaid',
    ADD COLUMN IF NOT EXISTS amount_paid                NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS stripe_payment_link_id     VARCHAR(64),
    ADD COLUMN IF NOT EXISTS stripe_payment_link_url    TEXT,
    ADD COLUMN IF NOT EXISTS payment_link_amount        NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS payment_link_sent_at       TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS payment_link_sent_by       VARCHAR(255),
    ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS stripe_paid_at             TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.bookings.payment_status IS 'Unpaid | Pending | Deposit paid | Paid | Refunded | Written off';
COMMENT ON COLUMN public.bookings.amount_paid IS 'Money received against this booking so far';
COMMENT ON COLUMN public.bookings.stripe_payment_link_id IS 'The Stripe Payment Link last emailed to the guest (plink_...)';
COMMENT ON COLUMN public.bookings.stripe_payment_link_url IS 'Its URL, as the guest received it';
COMMENT ON COLUMN public.bookings.payment_link_amount IS 'The amount that link asks for';
COMMENT ON COLUMN public.bookings.payment_link_sent_at IS 'When the link was last emailed';
COMMENT ON COLUMN public.bookings.stripe_checkout_session_id IS 'The last Stripe payment counted; stops a retried webhook counting it twice';
COMMENT ON COLUMN public.bookings.stripe_paid_at IS 'When Stripe last reported a payment for this booking';

-- Payment receipts and the pre-play clock.
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id   VARCHAR(255),
    ADD COLUMN IF NOT EXISTS stripe_last_payment_amount NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS payment_receipt_sent_at    TIMESTAMP WITH TIME ZONE;

-- Bookings already paid when the clock was introduced have started theirs.
-- Tied to the column's creation so it runs once, and never again on a
-- database where the app has been managing the clock itself.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'bookings'
       AND column_name = 'pre_play_clock_started_at'
  ) THEN
    ALTER TABLE public.bookings ADD COLUMN pre_play_clock_started_at TIMESTAMP WITH TIME ZONE;
    UPDATE public.bookings
       SET pre_play_clock_started_at = COALESCE(stripe_paid_at, NOW())
     WHERE payment_status IN ('Paid', 'Deposit paid');
  END IF;
END $$;

COMMENT ON COLUMN public.bookings.stripe_payment_intent_id IS 'Stripe reference (pi_...) of the last payment, quoted on the receipt';
COMMENT ON COLUMN public.bookings.stripe_last_payment_amount IS 'What the last Stripe payment was for, so its receipt can be resent';
COMMENT ON COLUMN public.bookings.payment_receipt_sent_at IS 'When the receipt for the last payment was emailed; NULL means it has not been';
COMMENT ON COLUMN public.bookings.pre_play_clock_started_at IS 'When payment started the pre-play email sequence';

-- ---------------------------------------------------------------------------
-- tour_operators, and the trade half of a booking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tour_operators (
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

-- One name per club, case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tour_operators_club_name
    ON public.tour_operators (club, LOWER(name));
CREATE INDEX IF NOT EXISTS idx_tour_operators_club ON public.tour_operators (club);

COMMENT ON TABLE  public.tour_operators IS 'Trade partners who book on behalf of guests, and the credit they trade on';
COMMENT ON COLUMN public.tour_operators.email_domains IS 'Sending domains that identify a booking as this operator''s';
COMMENT ON COLUMN public.tour_operators.payment_terms_days IS 'Net days from invoice date; 0 means payment on invoice';
COMMENT ON COLUMN public.tour_operators.deposit_percent IS 'Share of the booking total due as a deposit, 0-100';
COMMENT ON COLUMN public.tour_operators.deposit_due_days_before_play IS 'Deposit due this many days before play; NULL falls back to the invoice terms';
COMMENT ON COLUMN public.tour_operators.balance_due_days_before_play IS 'Balance due this many days before play; NULL falls back to the invoice terms';
COMMENT ON COLUMN public.tour_operators.credit_limit IS 'Maximum outstanding balance allowed on the account; NULL means no limit';
COMMENT ON COLUMN public.tour_operators.on_hold IS 'Account suspended — take no new business until it is settled';

ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS tour_operator_id INTEGER
        REFERENCES public.tour_operators(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS invoice_number   VARCHAR(64),
    ADD COLUMN IF NOT EXISTS invoiced_at      DATE,
    ADD COLUMN IF NOT EXISTS deposit_due_date DATE,
    ADD COLUMN IF NOT EXISTS balance_due_date DATE,
    -- Operator reminder send stamps, so a reminder is not sent twice.
    ADD COLUMN IF NOT EXISTS operator_status_email_sent_at  TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS operator_payment_email_sent_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.bookings.tour_operator_id IS 'The trade account this booking belongs to; NULL is a direct guest booking';
COMMENT ON COLUMN public.bookings.deposit_due_date IS 'Overrides the date derived from the operator''s credit terms';
COMMENT ON COLUMN public.bookings.balance_due_date IS 'Overrides the date derived from the operator''s credit terms';
COMMENT ON COLUMN public.bookings.operator_status_email_sent_at IS 'When this booking was last included in a booking-status reminder to its operator';
COMMENT ON COLUMN public.bookings.operator_payment_email_sent_at IS 'When this booking was last included in a payment reminder to its operator';

-- The tee times an availability email offered (written by the core API), so
-- the booking form can accept those and nothing else.
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS offered_tee_times JSONB;

-- ---------------------------------------------------------------------------
-- bookings indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bookings_club_status ON public.bookings (club, status);
CREATE INDEX IF NOT EXISTS idx_bookings_club_date ON public.bookings (club, date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON public.bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_hotel_checkin ON public.bookings (hotel_checkin);
CREATE INDEX IF NOT EXISTS idx_bookings_pre_arrival_email ON public.bookings (pre_arrival_email_sent_at);
CREATE INDEX IF NOT EXISTS idx_bookings_post_play_email ON public.bookings (post_play_email_sent_at);
CREATE INDEX IF NOT EXISTS idx_bookings_play_date_status ON public.bookings (date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_source ON public.bookings (club, source);
CREATE INDEX IF NOT EXISTS idx_bookings_import_batch ON public.bookings (import_batch)
    WHERE import_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_stripe_payment_link ON public.bookings (stripe_payment_link_id);
CREATE INDEX IF NOT EXISTS idx_bookings_tour_operator ON public.bookings (tour_operator_id);
CREATE INDEX IF NOT EXISTS idx_bookings_payment_status ON public.bookings (payment_status);
CREATE INDEX IF NOT EXISTS idx_bookings_balance_due ON public.bookings (balance_due_date);

-- ---------------------------------------------------------------------------
-- waitlist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.waitlist (
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

-- Which booking an entry became, and when. When the link is introduced, the
-- conversions the Streamlit dashboard recorded only in prose ("Converted from
-- waitlist: WL-0001.") are recovered from the booking notes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'waitlist'
       AND column_name = 'converted_booking_id'
  ) THEN
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

ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.waitlist.converted_booking_id IS
  'bookings.booking_id this entry became; NULL until it converts';
COMMENT ON COLUMN public.waitlist.converted_at IS
  'When the conversion was recorded — the clock for time-to-convert';

CREATE INDEX IF NOT EXISTS idx_waitlist_club_date ON public.waitlist (club, requested_date);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON public.waitlist (club, status);
CREATE INDEX IF NOT EXISTS idx_waitlist_converted ON public.waitlist (converted_booking_id)
    WHERE converted_booking_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- tee_times: the bookable sheet the core API quotes availability from. Rows
-- for a (club, course, date) override its simulated sheet for that day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tee_times (
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

CREATE INDEX IF NOT EXISTS idx_tee_times_lookup ON public.tee_times (club, course, date);
