-- ============================================================================
-- Sample guest requests (Guest Requests page)
-- ============================================================================
-- Ten guest bookings and the change requests their guests sent: amendments
-- (a new date, a new time, more or fewer players) and cancellations, six
-- waiting for a decision and four already dealt with by staff - approved,
-- declined, and a cancellation confirmed. Nothing is ever cancelled or changed
-- without staff approving it.
--
-- Paste the whole file into the SQL console and run it. Safe to run more than
-- once: it replaces its own sample requests each time. Dates are relative to
-- the day it runs. Guest addresses use the reserved example.com domain, so
-- nothing can be emailed to a real person. Rows go under the club your
-- dashboard users belong to (or 'royal_dornoch'); change v_club to force one.
--
-- To remove it later:
--   DELETE FROM public.booking_change_requests WHERE booking_id LIKE 'RD-DEMO-GR-%';
--   DELETE FROM public.bookings WHERE booking_id LIKE 'RD-DEMO-GR-%';
-- ============================================================================

BEGIN;

-- Schema: none here. Run the migrations first (npm run migrate, or start the
-- server, which runs them) — this file only adds sample rows.

-- ---------------------------------------------------------------------------
-- 2. The guests' bookings and their requests
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_club TEXT;
    v_fee  NUMERIC := 430;   -- green fee per player (EUR)
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
    RAISE NOTICE 'Seeding sample guest requests for club "%"', v_club;

    -- The bookings the requests are about. day = tee date relative to today.
    INSERT INTO public.bookings
        (booking_id, guest_email, guest_name, date, tee_time, players, total, status, note, club,
         timestamp, created_at, golf_courses)
    SELECT 'RD-DEMO-GR-' || g.n, g.email, g.name, CURRENT_DATE + g.day, g.tee_time, g.players,
           v_fee * g.players, g.status,
           'Booked via the website booking form.' || E'\n\nName: ' || g.name || E'\nEmail: ' || g.email
               || E'\nPlayers: ' || g.players,
           v_club, NOW() - (g.booked_days_ago || ' days')::INTERVAL, NOW() - (g.booked_days_ago || ' days')::INTERVAL,
           g.course
      FROM (VALUES
        -- n,     name,               email,                          day, tee time,   players, status,      booked, course
        ('1001', 'Sarah Whitfield',   'sarah.whitfield@example.com',  12, '09:10 AM', 4, 'Booked',    30, 'Championship Course'),
        ('1002', 'Michael Donnelly',  'm.donnelly@example.com',       19, '10:30 AM', 2, 'Booked',    21, 'Championship Course'),
        ('1003', 'Aoife Brennan',     'aoife.brennan@example.com',     6, '08:20 AM', 3, 'Booked',    40, 'Links Course'),
        ('1004', 'Tom Harrington',    'tom.harrington@example.com',   33, '01:10 PM', 4, 'Booked',    14, 'Championship Course'),
        ('1005', 'Claire Sinclair',   'claire.sinclair@example.com',   3, '11:50 AM', 2, 'Booked',    25, 'Links Course'),
        ('1006', 'Conor Fitzgerald',  'conor.fitz@example.com',       45, '09:40 AM', 4, 'Booked',     9, 'Championship Course'),
        ('1007', 'Rachel Pemberton',  'rachel.pemberton@example.com', 26, '02:20 PM', 2, 'Booked',    18, 'Championship Course'),
        ('1008', 'David McAllister',  'david.mcallister@example.com', 15, '08:00 AM', 3, 'Cancelled', 35, 'Championship Course'),
        ('1009', 'Emma Gallagher',    'emma.gallagher@example.com',   22, '10:04 AM', 2, 'Booked',    28, 'Links Course'),
        ('1010', 'Patrick Redmond',   'p.redmond@example.com',        40, '12:30 PM', 4, 'Booked',    12, 'Championship Course')
      ) AS g(n, name, email, day, tee_time, players, status, booked_days_ago, course)
    ON CONFLICT (booking_id) DO NOTHING;

    -- The requests: replaced on every run, so re-running never duplicates them.
    DELETE FROM public.booking_change_requests WHERE booking_id LIKE 'RD-DEMO-GR-%' AND club = v_club;

    INSERT INTO public.booking_change_requests
        (booking_id, club, kind, message, requested_date, requested_time, requested_players,
         status, auto_applied, days_before_play, resolved_at, resolved_by, resolution_note,
         guest_email, created_at)
    SELECT 'RD-DEMO-GR-' || r.n, v_club, r.kind, r.message,
           CASE WHEN r.move_to IS NULL THEN NULL ELSE CURRENT_DATE + r.move_to END,
           r.new_time, r.new_players, r.status, r.auto_applied,
           b.day - r.asked_days_ago,
           CASE WHEN r.status = 'Pending' THEN NULL ELSE NOW() - ((r.asked_days_ago - 1) || ' days')::INTERVAL END,
           CASE WHEN r.status = 'Pending' THEN NULL ELSE 'Jamie Kenny' END,
           r.note, b.email, NOW() - (r.asked_days_ago || ' days')::INTERVAL - INTERVAL '3 hours'
      FROM (VALUES
        -- Waiting for a decision
        ('1001', 'amend', 'One of our group has had to drop out - could we reduce the booking to three players please?',
                 NULL::INT, NULL, 3, 'Pending', FALSE, 1, NULL),
        ('1002', 'amend', 'Our flight has been moved. Is there anything available a week later, in the morning?',
                 26, '09:00 AM', NULL, 'Pending', FALSE, 0, NULL),
        ('1003', 'cancel', 'Unfortunately I have broken my wrist and will not be able to play. Please cancel - sorry for the short notice.',
                 NULL, NULL, NULL, 'Pending', FALSE, 0, NULL),
        ('1004', 'amend', 'Could we move to an earlier tee time on the same day? Anything before 10am would be ideal.',
                 33, '09:30 AM', NULL, 'Pending', FALSE, 2, NULL),
        ('1005', 'amend', 'A friend is joining us - can we make it a three-ball? Happy to pay the extra green fee.',
                 NULL, NULL, 3, 'Pending', FALSE, 1, NULL),
        ('1006', 'cancel', 'Plans have changed and we will not be travelling to Scotland this year. Please cancel our tee time.',
                 NULL, NULL, NULL, 'Pending', FALSE, 0, NULL),
        -- Already dealt with
        ('1007', 'amend', 'Could we push back to the afternoon of the next day?',
                 27, '03:10 PM', NULL, 'Approved', FALSE, 5, 'Moved to 3:10 PM the following day; guest confirmed by email.'),
        ('1008', 'cancel', 'Family emergency - we need to cancel, apologies.',
                 NULL, NULL, NULL, 'Applied', FALSE, 8, 'Cancellation approved; booking cancelled and the guest emailed.'),
        ('1009', 'amend', 'Is there any chance of a Sunday tee time instead?',
                 20, '10:00 AM', NULL, 'Declined', FALSE, 4, 'No visitor tee times on Sundays that month - offered Saturday instead.'),
        ('1010', 'amend', 'We are now a group of four rather than two.',
                 NULL, NULL, 4, 'Approved', FALSE, 6, 'Two more players added to the booking; guest confirmed by email.')
      ) AS r(n, kind, message, move_to, new_time, new_players, status, auto_applied, asked_days_ago, note)
      JOIN (VALUES
        ('1001', 12, 'sarah.whitfield@example.com'), ('1002', 19, 'm.donnelly@example.com'),
        ('1003',  6, 'aoife.brennan@example.com'),   ('1004', 33, 'tom.harrington@example.com'),
        ('1005',  3, 'claire.sinclair@example.com'), ('1006', 45, 'conor.fitz@example.com'),
        ('1007', 26, 'rachel.pemberton@example.com'),('1008', 15, 'david.mcallister@example.com'),
        ('1009', 22, 'emma.gallagher@example.com'),  ('1010', 40, 'p.redmond@example.com')
      ) AS b(n, day, email) ON b.n = r.n;
END $$;

COMMIT;

-- Check what was added:
-- SELECT r.booking_id, b.guest_name, r.kind, r.status, r.requested_date, r.requested_time,
--        r.requested_players, r.message
--   FROM public.booking_change_requests r
--   JOIN public.bookings b ON b.booking_id = r.booking_id AND b.club = r.club
--  WHERE r.booking_id LIKE 'RD-DEMO-GR-%' ORDER BY (r.status = 'Pending') DESC, r.created_at DESC;
