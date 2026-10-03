-- ============================================================================
-- Tour operator accounts (set-up only: no bookings)
-- ============================================================================
-- Six fictional trade accounts with their contacts, the email domains their
-- bookings are recognised by, and their credit terms:
--
--   Account                      Terms                                          Limit      State
--   Fairway & Firth Golf Tours   25% deposit 60d before play, balance 30d, net 30  EUR 60,000  Trading
--   Links Trail Golf Travel      Net 30                                          EUR 20,000  Trading
--   Atlantic Tee Holidays        50% deposit on invoice, balance 45d before play, net 14  EUR 80,000  Trading
--   Highland Swing Golf Breaks   Net 30                                          EUR  5,000  ON HOLD
--   Clubhouse Corporate Events   Net 14                                          no limit    Trading
--   Old Course Connections       20% deposit 90d before play, balance 30d, net 30  EUR 15,000  Retired
--
-- Paste the whole file into the SQL console. Safe to run more than once: it
-- refreshes these sample accounts and never overwrites a real operator with
-- the same name. Addresses are on the reserved .example domain, so an operator
-- reminder can never reach a real company. Accounts are created under the club
-- your dashboard users belong to (or 'royal_dornoch'); change v_club to force one.
--
-- For sample bookings and balances against these accounts as well, run
-- seed_tour_operators.sql instead (it includes this).
-- ============================================================================

-- Schema: none here. Run the migrations first (npm run migrate, or start the
-- server, which runs them) — this file only adds sample rows.

-- The accounts
DO $$
DECLARE
    v_club   TEXT;
    v_note   TEXT := 'Sample operator (seeded).';
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
    RAISE NOTICE 'Setting up sample tour operator accounts for club "%"', v_club;

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
END $$;

-- Check what was set up:
-- SELECT name, account_code, contact_email, email_domains, payment_terms_days, deposit_percent,
--        deposit_due_days_before_play, balance_due_days_before_play, credit_limit, currency, on_hold, active
--   FROM public.tour_operators WHERE notes LIKE 'Sample operator (seeded).%' ORDER BY name;

-- To remove these accounts later (their bookings, if any, are kept and become direct bookings):
-- DELETE FROM public.tour_operators WHERE notes LIKE 'Sample operator (seeded).%';
