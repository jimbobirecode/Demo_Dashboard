-- ============================================================================
-- Sample tour operators, with their group bookings and balances
-- ============================================================================
-- Six fictional trade accounts and 22 bookings, one account for each state the
-- Tour Operators page shows:
--
--   Fairway & Firth Golf Tours   model account, 25% deposit, nothing overdue
--   Links Trail Golf Travel      running 45 days late, close to its limit
--   Atlantic Tee Holidays        50% deposit up front, balance overdue
--   Highland Swing Golf Breaks   ON HOLD and over its credit limit
--   Clubhouse Corporate Events   corporate, 14-day terms, no limit
--   Old Course Connections       retired partner, settled
--
-- Paste the whole file into the SQL console (or: psql "$DATABASE_URL" -f
-- seed_tour_operators.sql). Safe to run more than once.
--
-- * Dates are relative to the day it runs, so "days overdue" stays believable.
-- * Prices: EUR 430 per player; 36-hole groups at the 50% same-day replay rate.
-- * Every address is on the reserved .example domain, so an operator reminder
--   can never reach a real company.
-- * Bookings go under the club your dashboard users belong to (the club with
--   the most users), or 'royal_dornoch' if there are none. To force a club,
--   change v_club in the DO block below.
-- * A real operator that already has one of these names is left untouched.
-- * To remove everything this adds, run the block at the very bottom.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema (the tour operators migration; does nothing if already applied)
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
    payment_terms_days          INTEGER NOT NULL DEFAULT 30,
    deposit_percent             NUMERIC(5,2) NOT NULL DEFAULT 0,
    deposit_due_days_before_play   INTEGER,
    balance_due_days_before_play   INTEGER,
    credit_limit        NUMERIC(12,2),
    currency            VARCHAR(3) NOT NULL DEFAULT 'GBP',

    -- Trading state. `on_hold` means no new business until the account is
    -- settled; `active` retires an operator without deleting their history.
    on_hold             BOOLEAN NOT NULL DEFAULT FALSE,
    active              BOOLEAN NOT NULL DEFAULT TRUE,

    notes               TEXT,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by          VARCHAR(255)
);

-- One name per club, case-insensitively: two rows called "Golfbreaks" would
-- split the same account's exposure in half.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tour_operators_club_name
    ON public.tour_operators (club, LOWER(name));
CREATE INDEX IF NOT EXISTS idx_tour_operators_club ON public.tour_operators (club);


-- ---------------------------------------------------------------------------
-- 2. The payment half of a booking
-- ---------------------------------------------------------------------------
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS tour_operator_id INTEGER
        REFERENCES public.tour_operators(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payment_status   VARCHAR(32) NOT NULL DEFAULT 'Unpaid',
    ADD COLUMN IF NOT EXISTS amount_paid      NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS invoice_number   VARCHAR(64),
    ADD COLUMN IF NOT EXISTS invoiced_at      DATE,
    ADD COLUMN IF NOT EXISTS deposit_due_date DATE,
    ADD COLUMN IF NOT EXISTS balance_due_date DATE;


-- ---------------------------------------------------------------------------
-- 3. Operator reminder send stamps
-- ---------------------------------------------------------------------------
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS operator_status_email_sent_at  TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS operator_payment_email_sent_at TIMESTAMP WITH TIME ZONE;


CREATE INDEX IF NOT EXISTS idx_bookings_tour_operator ON public.bookings (tour_operator_id);
CREATE INDEX IF NOT EXISTS idx_bookings_payment_status ON public.bookings (payment_status);
CREATE INDEX IF NOT EXISTS idx_bookings_balance_due ON public.bookings (balance_due_date);

-- ---------------------------------------------------------------------------
-- 2. The operators and their bookings
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_club   TEXT;
    v_fee    NUMERIC := 430;          -- green fee per player per round (EUR)
    v_note   TEXT := 'Sample operator (seeded).';
    v_type   TEXT;
BEGIN
    IF to_regclass('public.dashboard_users') IS NOT NULL THEN
        SELECT customer_id INTO v_club
          FROM public.dashboard_users
         WHERE customer_id IS NOT NULL
         GROUP BY customer_id
         ORDER BY COUNT(*) DESC
         LIMIT 1;
    END IF;
    v_club := COALESCE(v_club, 'royal_dornoch');
    RAISE NOTICE 'Seeding sample tour operators for club "%"', v_club;

    -- The operators. Re-running refreshes a sample operator's terms; a real
    -- operator with the same name is never overwritten.
    INSERT INTO public.tour_operators AS t
        (club, name, contact_name, contact_email, contact_phone, account_code, email_domains,
         payment_terms_days, deposit_percent, deposit_due_days_before_play, balance_due_days_before_play,
         credit_limit, currency, on_hold, active, notes, updated_by)
    SELECT v_club, s.name, s.contact, 'accounts@' || s.domain, s.phone, s.code, ARRAY[s.domain],
           s.days, s.deposit, s.deposit_before, s.balance_before, s.credit_limit, 'EUR',
           s.on_hold, s.active, v_note || ' ' || s.notes, 'seed'
      FROM (VALUES
        ('Fairway & Firth Golf Tours', 'FFG', 'Moira Buchanan', '+44 131 496 0101', 'fairwayfirth.example',
         30, 25, 60, 30, 60000::NUMERIC, FALSE, TRUE,
         'Long-standing partner. Pays promptly; prefers morning tee times for groups.'),
        ('Links Trail Golf Travel', 'LTG', 'Callum Reid', '+44 20 7946 0102', 'linkstrail.example',
         30, 0, NULL, NULL, 20000, FALSE, TRUE,
         'High volume. Balances regularly run past 30 days - chase early.'),
        ('Atlantic Tee Holidays', 'ATH', 'Brooke Sullivan', '+1 617 555 0103', 'atlantictee.example',
         14, 50, NULL, 45, 80000, FALSE, TRUE,
         'North American groups. 50% deposit on invoice, balance 45 days before play.'),
        ('Highland Swing Golf Breaks', 'HSG', 'Euan Mackay', '+44 1463 496 0104', 'highlandswing.example',
         30, 0, NULL, NULL, 5000, TRUE, TRUE,
         'ON HOLD: two invoices over 90 days and over its credit limit. No new tee times until the account is settled.'),
        ('Clubhouse Corporate Events', 'CCE', 'Priya Nair', '+44 161 496 0105', 'clubhouseevents.example',
         14, 0, NULL, NULL, NULL, FALSE, TRUE,
         'Corporate days and client golf. Invoiced on booking, 14-day terms.'),
        ('Old Course Connections', 'OCC', 'Graham Lister', '+44 1334 496 0106', 'oldcourseconnections.example',
         30, 20, 90, 30, 15000, FALSE, FALSE,
         'Retired partner - ceased trading with the club. Kept for history.')
      ) AS s(name, code, contact, phone, domain, days, deposit, deposit_before, balance_before,
             credit_limit, on_hold, active, notes)
    ON CONFLICT (club, (LOWER(name))) DO UPDATE SET
        contact_name = EXCLUDED.contact_name, contact_email = EXCLUDED.contact_email,
        contact_phone = EXCLUDED.contact_phone, account_code = EXCLUDED.account_code,
        email_domains = EXCLUDED.email_domains, payment_terms_days = EXCLUDED.payment_terms_days,
        deposit_percent = EXCLUDED.deposit_percent,
        deposit_due_days_before_play = EXCLUDED.deposit_due_days_before_play,
        balance_due_days_before_play = EXCLUDED.balance_due_days_before_play,
        credit_limit = EXCLUDED.credit_limit, currency = EXCLUDED.currency,
        on_hold = EXCLUDED.on_hold, active = EXCLUDED.active, notes = EXCLUDED.notes,
        updated_at = NOW(), updated_by = 'seed'
    WHERE t.notes LIKE 'Sample operator (seeded).%';

    -- Their bookings. day = tee date relative to today; invoiced = days ago it
    -- was invoiced (NULL = not yet); paid = share of the total received.
    INSERT INTO public.bookings
        (booking_id, guest_email, date, tee_time, players, total, status, note, club,
         timestamp, created_at, golf_courses,
         tour_operator_id, payment_status, amount_paid, invoice_number, invoiced_at)
    SELECT
        'RD-DEMO-OP-' || b.code || '-' || LPAD(b.n::TEXT, 2, '0'),
        'groups@' || o.email_domains[1],
        CURRENT_DATE + b.day,
        TO_CHAR(b.start_at, 'HH12:MI AM'),
        b.players,
        ROUND(v_fee * CASE WHEN b.rounds = 2 THEN 1.5 ELSE 1 END * b.players, 2),
        b.status,
        'Group booking from ' || o.name || ' (account ' || b.code || ').' || E'\n\n'
            || 'Contact: ' || o.contact_name || E'\n'
            || 'Players: ' || b.players || ' (' || CEIL(b.players / 4.0) || ' tee time'
            || CASE WHEN b.players > 4 THEN 's' ELSE '' END || ')' || E'\n'
            || 'Course: ' || CASE WHEN b.rounds = 2 THEN 'Championship Course, Links Course' ELSE 'Championship Course' END
            || CASE WHEN b.rounds = 2 THEN E'\nPlaying 36 holes - second round charged at the 50% same-day replay rate.' ELSE '' END,
        v_club,
        (CURRENT_DATE + LEAST(b.day, 0) - COALESCE(b.invoiced, 3) - 5) + TIME '09:30',
        (CURRENT_DATE + LEAST(b.day, 0) - COALESCE(b.invoiced, 3) - 5) + TIME '09:30',
        CASE WHEN b.rounds = 2 THEN 'Championship Course, Links Course' ELSE 'Championship Course' END,
        o.id,
        CASE WHEN b.paid <= 0 THEN 'Unpaid' WHEN b.paid >= 1 THEN 'Paid' ELSE 'Deposit paid' END,
        ROUND(v_fee * CASE WHEN b.rounds = 2 THEN 1.5 ELSE 1 END * b.players * b.paid, 2),
        CASE WHEN b.invoiced IS NULL THEN NULL ELSE 'INV-' || b.code || '-' || (2599 + b.n) END,
        CASE WHEN b.invoiced IS NULL THEN NULL ELSE CURRENT_DATE - b.invoiced END
      FROM (VALUES
        -- code, n, day, players, rounds, status, invoiced, paid, first tee time
        ('FFG', 1,  -35,  8, 1, 'Booked',    70,   1.00, TIME '08:00'),
        ('FFG', 2,  -12, 12, 2, 'Booked',    50,   1.00, TIME '08:10'),
        ('FFG', 3,   24,  8, 1, 'Booked',    40,   1.00, TIME '08:20'),
        ('FFG', 4,   45, 16, 2, 'Booked',    20,   0.25, TIME '08:30'),
        ('FFG', 5,   75,  8, 1, 'Booked',     5,   0.00, TIME '09:00'),
        ('FFG', 6,  110,  4, 1, 'Requested', NULL, 0.00, TIME '09:10'),
        ('LTG', 1,  -60, 12, 1, 'Booked',    75,   0.00, TIME '08:00'),
        ('LTG', 2,  -40,  8, 1, 'Booked',    50,   0.50, TIME '08:10'),
        ('LTG', 3,   -8,  8, 2, 'Booked',    15,   0.00, TIME '08:20'),
        ('LTG', 4,   18, 12, 1, 'Booked',    10,   0.00, TIME '08:30'),
        ('LTG', 5,   40,  8, 1, 'Inquiry',   NULL, 0.00, TIME '09:00'),
        ('ATH', 1,   30, 16, 2, 'Booked',    90,   0.50, TIME '08:00'),
        ('ATH', 2,   65, 12, 1, 'Booked',    30,   0.50, TIME '08:10'),
        ('ATH', 3,   95, 20, 2, 'Booked',    20,   0.00, TIME '08:20'),
        ('ATH', 4,  140,  8, 1, 'Requested', NULL, 0.00, TIME '08:30'),
        ('HSG', 1, -130,  8, 1, 'Booked',   140,   0.00, TIME '08:00'),
        ('HSG', 2, -100,  4, 2, 'Booked',   110,   0.25, TIME '08:10'),
        ('HSG', 3,   20,  8, 1, 'Requested', NULL, 0.00, TIME '08:20'),
        ('CCE', 1,  -20, 24, 1, 'Booked',    45,   1.00, TIME '08:00'),
        ('CCE', 2,   12, 16, 1, 'Booked',    10,   0.00, TIME '08:10'),
        ('CCE', 3,   55, 32, 1, 'Confirmed', NULL, 0.00, TIME '08:20'),
        ('OCC', 1, -300,  8, 1, 'Booked',   330,   1.00, TIME '08:00')
      ) AS b(code, n, day, players, rounds, status, invoiced, paid, start_at)
      JOIN public.tour_operators o
        ON o.club = v_club AND o.account_code = b.code AND o.notes LIKE 'Sample operator (seeded).%'
    ON CONFLICT (booking_id) DO NOTHING;

    -- Each group's tee times: one per four players, ten minutes apart. The
    -- column is JSONB on some databases and TEXT on others, so it is written
    -- as whichever this one has.
    SELECT format_type(atttypid, atttypmod) INTO v_type
      FROM pg_attribute
     WHERE attrelid = 'public.bookings'::regclass AND attname = 'selected_tee_times' AND NOT attisdropped;
    IF v_type IN ('jsonb', 'json') THEN
        EXECUTE format($sql$
            UPDATE public.bookings b
               SET selected_tee_times = (
                   SELECT jsonb_agg(jsonb_build_object(
                              'date', b.date,
                              'time', TO_CHAR(b.tee_time::TIME + i * INTERVAL '10 minutes', 'HH12:MI AM'),
                              'course_name', SPLIT_PART(b.golf_courses, ', ', 1),
                              'players', LEAST(4, b.players - i * 4)) ORDER BY i)
                     FROM GENERATE_SERIES(0, CEIL(b.players / 4.0)::INT - 1) AS i)::%s
             WHERE b.booking_id LIKE 'RD-DEMO-OP-%%' AND b.selected_tee_times IS NULL
        $sql$, v_type);
    ELSIF v_type IS NOT NULL THEN
        EXECUTE format($sql$
            UPDATE public.bookings b
               SET selected_tee_times = (
                   SELECT STRING_AGG(TO_CHAR(b.tee_time::TIME + i * INTERVAL '10 minutes', 'HH12:MI AM'), ', ' ORDER BY i)
                     FROM GENERATE_SERIES(0, CEIL(b.players / 4.0)::INT - 1) AS i)::%s
             WHERE b.booking_id LIKE 'RD-DEMO-OP-%%' AND b.selected_tee_times IS NULL
        $sql$, v_type);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- To remove the sample operators and their bookings later, run:
-- ---------------------------------------------------------------------------
-- DELETE FROM public.bookings WHERE booking_id LIKE 'RD-DEMO-OP-%';
-- DELETE FROM public.tour_operators WHERE notes LIKE 'Sample operator (seeded).%';
