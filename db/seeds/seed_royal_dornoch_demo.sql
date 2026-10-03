-- ============================================================================
-- ROYAL DORNOCH GOLF CLUB - DASHBOARD DEMO SEED
-- ============================================================================
--
-- A demo login and a realistic spread of visitor bookings for
-- club = 'royal_dornoch' so every dashboard page has something to show.
-- The schema comes from db/migrations; run those first.
--
-- Usage:
--   npm run migrate && psql $DATABASE_URL -f db/seeds/seed_royal_dornoch_demo.sql
--
-- Demo login:  username  dornoch_demo  (no password is set; see below)
--
-- Re-runnable: existing RDG-DEMO-* rows are replaced.
-- ============================================================================

BEGIN;

-- Schema: none here. Run the migrations first (npm run migrate, or start the
-- server, which runs them) — this file only adds sample rows.

-- ---------------------------------------------------------------------------
-- Demo login (no password: set one before first use)
-- ---------------------------------------------------------------------------
--
-- Created with no usable password. A credential committed to the repository is
-- a credential anyone with read access has, so none is set here. Give the
-- account one of these ways before signing in:
--
--   * give it an email address (UPDATE dashboard_users SET email = '...'
--     WHERE username = 'dornoch_demo') and use "Forgot password" on the
--     login page, or have an administrator send it an invitation from the
--     Users page;
--   * or set a bcrypt hash by hand: UPDATE dashboard_users SET password_hash
--     = '<bcrypt hash>' WHERE username = 'dornoch_demo'.
--
-- Re-running this file never touches an existing account's password.
INSERT INTO dashboard_users (username, customer_id, full_name, is_active, must_change_password)
VALUES ('dornoch_demo', 'royal_dornoch', 'Royal Dornoch Golf Office', TRUE, FALSE)
ON CONFLICT (username) DO UPDATE
    SET customer_id = EXCLUDED.customer_id,
        full_name = EXCLUDED.full_name;

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
DELETE FROM bookings WHERE club = 'royal_dornoch' AND booking_id LIKE 'RDG-DEMO-%';

INSERT INTO bookings (
    booking_id, guest_email, guest_name, date, tee_time, players, total, status, note, club,
    timestamp, created_at, customer_confirmed_at, updated_at, updated_by,
    hotel_required, hotel_checkin, hotel_checkout, lodging_nights, lodging_rooms, lodging_room_type,
    lodging_preferences, lodging_cost, golf_dates, golf_courses, selected_tee_times
) VALUES

-- Inquiry: bot has replied, guest has not chosen yet
('RDG-DEMO-0001', 'tom.harris@example.com', 'Tom Harris',
 CURRENT_DATE + 12, '8:00 AM', 4, 1440.00, 'Inquiry',
 'Inquiry received ' || to_char(NOW() - INTERVAL '2 hours', 'YYYY-MM-DD HH24:MI') ||
 E'\nCourse: Championship Course\nDate: ' || to_char(CURRENT_DATE + 12, 'YYYY-MM-DD') ||
 E'\nTime: 8:00 AM\nNumber of Players: 4\nPrice per Player: £360.00\nTotal Cost: £1,440.00',
 'royal_dornoch', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours', NULL, NULL, NULL,
 FALSE, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
 ARRAY[to_char(CURRENT_DATE + 12, 'YYYY-MM-DD')], 'Championship Course',
 jsonb_build_array(jsonb_build_object('date', to_char(CURRENT_DATE + 12, 'YYYY-MM-DD'), 'time', '8:00 AM',
   'course_name', 'Championship Course', 'players', 4, 'price', 360.00))),

('RDG-DEMO-0002', 'fiona.grant@example.com', 'Fiona Grant',
 CURRENT_DATE + 20, '10:10 AM', 2, 200.00, 'Inquiry',
 'Inquiry received ' || to_char(NOW() - INTERVAL '1 day', 'YYYY-MM-DD HH24:MI') ||
 E'\nCourse: Struie Course\nDate: ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') ||
 E'\nTime: 10:10 AM\nNumber of Players: 2\nPrice per Player: £100.00\nTotal Cost: £200.00',
 'royal_dornoch', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NULL, NULL, NULL,
 FALSE, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
 ARRAY[to_char(CURRENT_DATE + 20, 'YYYY-MM-DD')], 'Struie Course',
 jsonb_build_array(jsonb_build_object('date', to_char(CURRENT_DATE + 20, 'YYYY-MM-DD'), 'time', '10:10 AM',
   'course_name', 'Struie Course', 'players', 2, 'price', 100.00))),

-- Requested: guest clicked "Request this tee time" - staff action needed
('RDG-DEMO-0003', 'sarah.mcleod@example.com', 'Sarah McLeod',
 CURRENT_DATE + 15, '9:10 AM', 4, 1840.00, 'Requested',
 'Customer responded ' || to_char(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') ||
 E'\nGOLF ROUNDS:\nDay 1 - ' || to_char(CURRENT_DATE + 15, 'DD Month') || E': Championship Course at 9:10 AM\nDay 2 - ' ||
 to_char(CURRENT_DATE + 16, 'DD Month') || E': Struie Course at 10:00 AM\n\nACCOMMODATION (via partner hotel):\nNights: 3\nRooms: 2 Partner Hotel Room(s)\nGuests: 4',
 'royal_dornoch', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours', 'email_bot',
 TRUE, CURRENT_DATE + 14, CURRENT_DATE + 17, 3, 2, 'twin', 'Royal Golf Hotel preferred', 1320.00,
 ARRAY[to_char(CURRENT_DATE + 15, 'YYYY-MM-DD'), to_char(CURRENT_DATE + 16, 'YYYY-MM-DD')], 'Championship Course, Struie Course',
 jsonb_build_array(
   jsonb_build_object('date', to_char(CURRENT_DATE + 15, 'YYYY-MM-DD'), 'time', '9:10 AM', 'course_name', 'Championship Course', 'players', 4, 'price', 360.00),
   jsonb_build_object('date', to_char(CURRENT_DATE + 16, 'YYYY-MM-DD'), 'time', '10:00 AM', 'course_name', 'Struie Course', 'players', 4, 'price', 100.00))),

('RDG-DEMO-0004', 'events@northerncapital.example.com', 'Northern Capital Events',
 CURRENT_DATE + 30, '9:00 AM', 12, 4320.00, 'Requested',
 'Customer responded ' || to_char(NOW() - INTERVAL '6 hours', 'YYYY-MM-DD HH24:MI:SS') ||
 E'\nGROUP BOOKING - 12 players\nCourse: Championship Course\nDate: ' || to_char(CURRENT_DATE + 30, 'YYYY-MM-DD') ||
 E'\nTime: 9:00 AM, 9:10 AM, 9:20 AM (3 consecutive tee times)\nNumber of Players: 12\nTotal Cost: £4,320.00',
 'royal_dornoch', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '6 hours', 'email_bot',
 FALSE, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
 ARRAY[to_char(CURRENT_DATE + 30, 'YYYY-MM-DD')], 'Championship Course',
 jsonb_build_array(jsonb_build_object('date', to_char(CURRENT_DATE + 30, 'YYYY-MM-DD'), 'time', '9:00 AM',
   'course_name', 'Championship Course', 'players', 12, 'price', 360.00))),

-- Booked: tee time held, payment details sent (customer-journey welcome email due in 3 days)
('RDG-DEMO-0005', 'mike.obrien@example.com', 'Mike O''Brien',
 CURRENT_DATE + 3, '8:20 AM', 4, 1440.00, 'Booked',
 'Confirmed by golf office. Course: Championship Course. Time: 8:20 AM. Payment link sent.',
 'royal_dornoch', NOW() - INTERVAL '9 days', NOW() - INTERVAL '9 days', NOW() - INTERVAL '8 days', NOW() - INTERVAL '7 days', 'dornoch_demo',
 TRUE, CURRENT_DATE + 2, CURRENT_DATE + 5, 3, 2, 'double', 'Links House', 2370.00,
 ARRAY[to_char(CURRENT_DATE + 3, 'YYYY-MM-DD')], 'Championship Course',
 jsonb_build_array(jsonb_build_object('date', to_char(CURRENT_DATE + 3, 'YYYY-MM-DD'), 'time', '8:20 AM',
   'course_name', 'Championship Course', 'players', 4, 'price', 360.00))),

('RDG-DEMO-0006', 'hans.mueller@example.de', 'Hans Mueller',
 CURRENT_DATE + 8, '2:30 PM', 3, 1080.00, 'Booked',
 'Confirmed. Course: Championship Course. Time: 2:30 PM. Handicap certificates received.',
 'royal_dornoch', NOW() - INTERVAL '12 days', NOW() - INTERVAL '12 days', NOW() - INTERVAL '11 days', NOW() - INTERVAL '10 days', 'dornoch_demo',
 FALSE, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
 ARRAY[to_char(CURRENT_DATE + 8, 'YYYY-MM-DD')], 'Championship Course',
 jsonb_build_array(jsonb_build_object('date', to_char(CURRENT_DATE + 8, 'YYYY-MM-DD'), 'time', '2:30 PM',
   'course_name', 'Championship Course', 'players', 3, 'price', 360.00))),

-- Booked: paid in full
('RDG-DEMO-0007', 'jenny.walsh@example.com', 'Jenny Walsh',
 CURRENT_DATE + 25, '10:40 AM', 4, 1840.00, 'Booked',
 'Paid in full. Day 1 Championship 10:40 AM, Day 2 Struie 9:30 AM. Staying at Dornoch Station.',
 'royal_dornoch', NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days', NOW() - INTERVAL '19 days', NOW() - INTERVAL '15 days', 'dornoch_demo',
 TRUE, CURRENT_DATE + 24, CURRENT_DATE + 27, 3, 2, 'twin', 'Dornoch Station', 1080.00,
 ARRAY[to_char(CURRENT_DATE + 25, 'YYYY-MM-DD'), to_char(CURRENT_DATE + 26, 'YYYY-MM-DD')], 'Championship Course, Struie Course',
 jsonb_build_array(
   jsonb_build_object('date', to_char(CURRENT_DATE + 25, 'YYYY-MM-DD'), 'time', '10:40 AM', 'course_name', 'Championship Course', 'players', 4, 'price', 360.00),
   jsonb_build_object('date', to_char(CURRENT_DATE + 26, 'YYYY-MM-DD'), 'time', '9:30 AM', 'course_name', 'Struie Course', 'players', 4, 'price', 100.00))),

('RDG-DEMO-0008', 'carl.jensen@example.dk', 'Carl Jensen',
 CURRENT_DATE + 45, '7:50 AM', 4, 1440.00, 'Booked',
 'Paid in full. Course: Championship Course. Time: 7:50 AM.',
 'royal_dornoch', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW() - INTERVAL '29 days', NOW() - INTERVAL '25 days', 'dornoch_demo',
 FALSE, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
 ARRAY[to_char(CURRENT_DATE + 45, 'YYYY-MM-DD')], 'Championship Course',
 jsonb_build_array(jsonb_build_object('date', to_char(CURRENT_DATE + 45, 'YYYY-MM-DD'), 'time', '7:50 AM',
   'course_name', 'Championship Course', 'players', 4, 'price', 360.00))),

-- Played recently (customer-journey thank-you email due) and history for the reports page
('RDG-DEMO-0009', 'david.brown@example.com', 'David Brown',
 CURRENT_DATE - 2, '9:40 AM', 4, 1440.00, 'Booked',
 'Played. Course: Championship Course. Time: 9:40 AM.',
 'royal_dornoch', NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days', NOW() - INTERVAL '39 days', NOW() - INTERVAL '35 days', 'dornoch_demo',
 FALSE, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
 ARRAY[to_char(CURRENT_DATE - 2, 'YYYY-MM-DD')], 'Championship Course',
 jsonb_build_array(jsonb_build_object('date', to_char(CURRENT_DATE - 2, 'YYYY-MM-DD'), 'time', '9:40 AM',
   'course_name', 'Championship Course', 'players', 4, 'price', 360.00))),

('RDG-DEMO-0010', 'lisa.taylor@example.com', 'Lisa Taylor',
 CURRENT_DATE - 10, '11:20 AM', 2, 720.00, 'Booked',
 'Paid in full. Course: Championship Course. Time: 11:20 AM.',
 'royal_dornoch', NOW() - INTERVAL '50 days', NOW() - INTERVAL '50 days', NOW() - INTERVAL '48 days', NOW() - INTERVAL '45 days', 'dornoch_demo',
 TRUE, CURRENT_DATE - 11, CURRENT_DATE - 9, 2, 1, 'double', 'Dornoch Castle Hotel', 390.00,
 ARRAY[to_char(CURRENT_DATE - 10, 'YYYY-MM-DD')], 'Championship Course',
 jsonb_build_array(jsonb_build_object('date', to_char(CURRENT_DATE - 10, 'YYYY-MM-DD'), 'time', '11:20 AM',
   'course_name', 'Championship Course', 'players', 2, 'price', 360.00))),

('RDG-DEMO-0011', 'ken.watanabe@example.jp', 'Ken Watanabe',
 CURRENT_DATE - 24, '8:30 AM', 4, 1840.00, 'Booked',
 'Paid in full. Day 1 Championship 8:30 AM, Day 2 Struie 8:40 AM.',
 'royal_dornoch', NOW() - INTERVAL '70 days', NOW() - INTERVAL '70 days', NOW() - INTERVAL '68 days', NOW() - INTERVAL '60 days', 'dornoch_demo',
 TRUE, CURRENT_DATE - 25, CURRENT_DATE - 22, 3, 2, 'twin', 'Royal Golf Hotel', 1320.00,
 ARRAY[to_char(CURRENT_DATE - 24, 'YYYY-MM-DD'), to_char(CURRENT_DATE - 23, 'YYYY-MM-DD')], 'Championship Course, Struie Course',
 jsonb_build_array(
   jsonb_build_object('date', to_char(CURRENT_DATE - 24, 'YYYY-MM-DD'), 'time', '8:30 AM', 'course_name', 'Championship Course', 'players', 4, 'price', 360.00),
   jsonb_build_object('date', to_char(CURRENT_DATE - 23, 'YYYY-MM-DD'), 'time', '8:40 AM', 'course_name', 'Struie Course', 'players', 4, 'price', 100.00))),

-- Rejected: no availability during a member competition
('RDG-DEMO-0012', 'alan.reid@example.com', 'Alan Reid',
 CURRENT_DATE + 5, '9:00 AM', 8, 2880.00, 'Rejected',
 'Rejected - Saturday morning club medal, no visitor times. Offered Sunday afternoon instead.',
 'royal_dornoch', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days', NULL, NOW() - INTERVAL '3 days', 'dornoch_demo',
 FALSE, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
 ARRAY[to_char(CURRENT_DATE + 5, 'YYYY-MM-DD')], 'Championship Course', NULL);

-- ---------------------------------------------------------------------------
-- Waitlist
-- ---------------------------------------------------------------------------
DELETE FROM waitlist WHERE club = 'royal_dornoch' AND waitlist_id LIKE 'WL-DEMO-%';

INSERT INTO waitlist (waitlist_id, guest_email, guest_name, requested_date, preferred_time, time_flexibility, players, golf_course, status, priority, notes, club)
VALUES
('WL-DEMO-0001', 'alan.reid@example.com', 'Alan Reid', CURRENT_DATE + 5, 'Morning', 'Flexible', 8, 'Championship Course', 'Waiting', 7, 'Happy with Sunday if Saturday stays full', 'royal_dornoch'),
('WL-DEMO-0002', 'p.nilsson@example.se', 'Petra Nilsson', CURRENT_DATE + 12, 'Afternoon', 'Same day only', 2, 'Championship Course', 'Waiting', 5, NULL, 'royal_dornoch'),
('WL-DEMO-0003', 'greg.moore@example.com', 'Greg Moore', CURRENT_DATE + 18, 'Any', 'Flexible', 4, 'Struie Course', 'Notified', 4, 'Notified of 15:30 opening', 'royal_dornoch');

-- Guest details as captured by the hosted booking form (Requested and later)
UPDATE bookings SET contact_phone = '+44 7700 900123', caddie_requirements = '2 caddies',
    special_requests = E'Handicaps: 8, 12, 15, 21\nOne trolley please. We would love lunch in the clubhouse after the Struie round.',
    form_submitted_at = NOW() - INTERVAL '3 hours'
WHERE booking_id = 'RDG-DEMO-0003';
UPDATE bookings SET contact_phone = '+44 20 7946 0958', caddie_requirements = 'Please contact me to discuss',
    special_requests = E'Handicaps: mixed, 6 to 28\nCorporate day for Northern Capital - private dining for 12 after golf, invoice to the company.',
    form_submitted_at = NOW() - INTERVAL '6 hours'
WHERE booking_id = 'RDG-DEMO-0004';
UPDATE bookings SET contact_phone = '+1 617 555 0142', caddie_requirements = '4 caddies (one per player)',
    special_requests = E'Handicaps: 10, 14, 17, 19\nFirst trip to Scotland - staying at Links House.',
    form_submitted_at = NOW() - INTERVAL '8 days'
WHERE booking_id = 'RDG-DEMO-0005';
UPDATE bookings SET contact_phone = '+49 171 5550123', caddie_requirements = 'No caddies required',
    special_requests = 'Handicaps: 5, 9, 11', form_submitted_at = NOW() - INTERVAL '11 days'
WHERE booking_id = 'RDG-DEMO-0006';
UPDATE bookings SET contact_phone = '+353 87 555 0199', caddie_requirements = '2 caddies',
    special_requests = E'Handicaps: 13, 16, 18, 22\nTwo buggies if possible for the Struie day.', form_submitted_at = NOW() - INTERVAL '19 days'
WHERE booking_id = 'RDG-DEMO-0007';
UPDATE bookings SET contact_phone = '+45 20 55 01 23', caddie_requirements = '1 caddie',
    special_requests = 'Handicaps: 4, 7, 12, 15', form_submitted_at = NOW() - INTERVAL '29 days'
WHERE booking_id = 'RDG-DEMO-0008';

COMMIT;

-- Sanity check
SELECT status, COUNT(*) AS bookings, SUM(total) AS revenue
FROM bookings WHERE club = 'royal_dornoch' GROUP BY status ORDER BY status;
