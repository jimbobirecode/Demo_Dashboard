-- ============================================================================
-- Membership demo (Membership page)
-- ============================================================================
-- Switches membership applications ON for the demo club, writes its reply
-- wording (enquiries arrive at memberships@club.teemail.io in the demo
-- environment), the seven membership categories with their fees (EUR), and
-- four sample applications at different stages with their timelines:
-- one just submitted, one under review, one approved and awaiting its
-- welcome, and one on the waitlist ready to be invited.
--
-- The club: 'royal_dornoch' (the demo profile's club id). To seed another,
-- change the default on the v_club line below, or set it for the session
-- first:   SET membership_seed.club = 'my_club';
-- (npm run seed does that with the club it resolves.)
--
-- Paste the whole file into the SQL console and run it, or:
--   psql "$DATABASE_URL" -f db/seeds/seed_membership_demo.sql
-- Safe to run more than once: categories are upserted by name, the sample
-- applications (references MEM-<date>-DEMO000n) are replaced, and the
-- service is switched back ON. Applicant addresses use the reserved
-- example.com domain, so nothing can be emailed to a real person.
--
-- To remove the sample applications later:
--   DELETE FROM public.membership_applications WHERE reference ~ '^MEM-[0-9]{8}-DEMO';
-- ============================================================================

BEGIN;

-- Schema: none here. Run the migrations first (npm run migrate, or start the
-- server, which runs them) — this file only adds sample rows.

DO $$
DECLARE
    v_club TEXT := COALESCE(NULLIF(current_setting('membership_seed.club', true), ''), 'royal_dornoch');
    v_full INTEGER;
    v_country INTEGER;
    v_intermediate INTEGER;
    v_senior INTEGER;
    v_family INTEGER;
    v_app INTEGER;
    v_msg INTEGER;
BEGIN
    RAISE NOTICE 'Seeding the membership demo for club "%"', v_club;

    -- -----------------------------------------------------------------------
    -- 1. The service switch and the reply wording
    -- -----------------------------------------------------------------------
    INSERT INTO public.club_settings (club, membership_enabled, membership_settings, updated_at, updated_by)
    VALUES (v_club, TRUE, jsonb_build_object(
        'intro', 'Thank you for your interest in becoming a member. Below are the membership categories we offer, with the ones that best match your enquiry first.',
        'next_steps', 'Once your fees are received we will send your membership card, arrange your locker and book you in for a welcome round with one of our professionals.',
        'closed_message', 'Membership applications are closed at the moment while the committee completes this year''s intake. Join our waitlist and we will invite you to apply as soon as places open.',
        'contact_email', 'memberships@club.teemail.io',
        'committee_name', 'The Membership Committee'
    ), NOW(), 'seed')
    ON CONFLICT (club) DO UPDATE SET
        membership_enabled  = TRUE,
        -- Wording the club has already written wins over the sample wording.
        membership_settings = EXCLUDED.membership_settings || public.club_settings.membership_settings,
        updated_at = NOW(),
        updated_by = 'seed';

    -- -----------------------------------------------------------------------
    -- 2. Categories (fees in EUR)
    -- -----------------------------------------------------------------------
    INSERT INTO public.membership_categories
        (club, name, description, eligibility, joining_fee, annual_fee, min_age, max_age, sort_order, active)
    SELECT v_club, c.name, c.description, c.eligibility, c.joining, c.annual, c.min_age, c.max_age, c.sort_order, TRUE
      FROM (VALUES
        ('Full',         'Seven-day playing rights on both courses, full voting rights and use of the clubhouse.',
                         'Adults living within 50 km of the club.',                     2500, 1850, 30,   NULL, 1),
        ('Country',      'Full playing rights for members who live further afield.',
                         'Main residence more than 50 km from the club.',               1200,  950, NULL, NULL, 2),
        ('Intermediate', 'Full playing rights at a reduced rate while you build your game and career.',
                         'Ages 19 to 29.',                                                500,  900, 19,   29,   3),
        ('Junior',       'Playing rights, coaching programme and junior competitions.',
                         'Under 19.',                                                       0,  250, NULL, 18,   4),
        ('Senior',       'Full playing rights with a seniors'' section and midweek competitions.',
                         'Aged 65 or over.',                                             1500, 1400, 65,   NULL, 5),
        ('Family',       'Two adults and their junior children, with full playing rights for all.',
                         'Two adults at the same address plus children under 19.',       4000, 3200, NULL, NULL, 6),
        ('Overseas',     'Playing rights for members who live outside the country.',
                         'Non-resident; main residence outside the UK and Ireland.',      1000,  750, NULL, NULL, 7)
      ) AS c(name, description, eligibility, joining, annual, min_age, max_age, sort_order)
    ON CONFLICT (club, name) DO UPDATE SET
        description = EXCLUDED.description,
        eligibility = EXCLUDED.eligibility,
        joining_fee = EXCLUDED.joining_fee,
        annual_fee  = EXCLUDED.annual_fee,
        min_age     = EXCLUDED.min_age,
        max_age     = EXCLUDED.max_age,
        sort_order  = EXCLUDED.sort_order,
        active      = TRUE,
        updated_at  = NOW();

    SELECT id INTO v_full         FROM public.membership_categories WHERE club = v_club AND name = 'Full';
    SELECT id INTO v_country      FROM public.membership_categories WHERE club = v_club AND name = 'Country';
    SELECT id INTO v_intermediate FROM public.membership_categories WHERE club = v_club AND name = 'Intermediate';
    SELECT id INTO v_senior       FROM public.membership_categories WHERE club = v_club AND name = 'Senior';
    SELECT id INTO v_family       FROM public.membership_categories WHERE club = v_club AND name = 'Family';

    -- -----------------------------------------------------------------------
    -- 3. Sample applications (replaced on every run)
    -- -----------------------------------------------------------------------
    DELETE FROM public.membership_applications WHERE club = v_club AND reference ~ '^MEM-[0-9]{8}-DEMO';
    DELETE FROM public.email_messages
     WHERE club = v_club AND intent = 'membership_enquiry'
       AND from_email IN ('isla.munro@example.com', 'callum.fraser@example.com',
                          'eilidh.mackenzie@example.com', 'margaret.sutherland@example.com');

    -- Isla Munro: enquired by email, applied for Full - waiting for review to start.
    INSERT INTO public.email_messages
        (club, direction, from_email, to_email, subject, body_text, intent, summary, routed_to, created_at)
    VALUES (v_club, 'inbound', 'isla.munro@example.com', 'memberships@club.teemail.io', 'Becoming a member',
            E'Hello,\n\nI moved to Dornoch in the summer and play off 11. I would love to join the club - could you tell me about membership and what it costs?\n\nMany thanks,\nIsla Munro',
            'membership_enquiry', 'Local golfer (handicap 11), recently moved to the area, asking about membership and fees.',
            'membership', NOW() - INTERVAL '6 days')
    RETURNING id INTO v_msg;

    INSERT INTO public.membership_applications
        (club, reference, kind, status, category_id, first_name, last_name, email, phone, date_of_birth, address,
         handicap, home_club, proposer, seconder, message, enquiry_summary, recommended_category_ids, consent,
         source_message_id, submitted_at, created_at, updated_at)
    VALUES (v_club, 'MEM-' || to_char(CURRENT_DATE - 6, 'YYYYMMDD') || '-DEMO0001', 'application', 'submitted', v_full,
            'Isla', 'Munro', 'isla.munro@example.com', '+44 7700 900101', DATE '1986-04-12',
            '4 Castle Street, Dornoch', '11.2', 'Tain Golf Club', 'Hamish Grant (member since 2004)', 'Morag Ross',
            'I have played the Championship Course as a visitor many times and would love to make it my home course.',
            'Local golfer (handicap 11), recently moved to the area, asking about membership and fees.',
            ARRAY[v_full, v_country], TRUE, v_msg, NOW() - INTERVAL '4 days', NOW() - INTERVAL '6 days', NOW() - INTERVAL '4 days')
    RETURNING id INTO v_app;
    INSERT INTO public.membership_events (application_id, club, event, actor, note, created_at) VALUES
        (v_app, v_club, 'enquired', 'bot', NULL, NOW() - INTERVAL '6 days'),
        (v_app, v_club, 'email:membership_reply', 'bot', NULL, NOW() - INTERVAL '6 days' + INTERVAL '1 minute'),
        (v_app, v_club, 'submitted', 'guest', NULL, NOW() - INTERVAL '4 days'),
        (v_app, v_club, 'email:membership_received', 'bot', NULL, NOW() - INTERVAL '4 days' + INTERVAL '1 minute');

    -- Callum Fraser: Intermediate, with the committee.
    INSERT INTO public.membership_applications
        (club, reference, kind, status, category_id, first_name, last_name, email, phone, date_of_birth,
         handicap, home_club, proposer, seconder, message, enquiry_summary, recommended_category_ids, consent,
         staff_notes, submitted_at, created_at, updated_at)
    VALUES (v_club, 'MEM-' || to_char(CURRENT_DATE - 15, 'YYYYMMDD') || '-DEMO0002', 'application', 'under_review', v_intermediate,
            'Callum', 'Fraser', 'callum.fraser@example.com', '+44 7700 900102', DATE '2000-09-03',
            '6.4', 'Inverness Golf Club', 'Iain MacLeod', 'Fiona Campbell',
            'Working in Inverness; keen to play competitions and join the scratch team.',
            '26-year-old asking about junior-to-adult membership options.',
            ARRAY[v_intermediate, v_full], TRUE,
            '[' || to_char(NOW() - INTERVAL '9 days', 'YYYY-MM-DD HH24:MI') || ' demo] Proposer confirmed by phone.',
            NOW() - INTERVAL '12 days', NOW() - INTERVAL '15 days', NOW() - INTERVAL '9 days')
    RETURNING id INTO v_app;
    INSERT INTO public.membership_events (application_id, club, event, actor, note, created_at) VALUES
        (v_app, v_club, 'enquired', 'bot', NULL, NOW() - INTERVAL '15 days'),
        (v_app, v_club, 'email:membership_reply', 'bot', NULL, NOW() - INTERVAL '15 days' + INTERVAL '1 minute'),
        (v_app, v_club, 'submitted', 'guest', NULL, NOW() - INTERVAL '12 days'),
        (v_app, v_club, 'email:membership_received', 'bot', NULL, NOW() - INTERVAL '12 days' + INTERVAL '1 minute'),
        (v_app, v_club, 'status:under_review', 'demo', 'For the committee meeting on the first Monday.', NOW() - INTERVAL '10 days'),
        (v_app, v_club, 'email:membership_under_review', 'demo', NULL, NOW() - INTERVAL '10 days' + INTERVAL '1 minute'),
        (v_app, v_club, 'note', 'demo', 'Proposer confirmed by phone.', NOW() - INTERVAL '9 days');

    -- The Mackenzies: Family, approved - ready to be welcomed.
    INSERT INTO public.membership_applications
        (club, reference, kind, status, category_id, first_name, last_name, email, phone, address,
         handicap, proposer, seconder, message, enquiry_summary, recommended_category_ids, consent,
         decision_note, decided_by, decided_at, submitted_at, created_at, updated_at)
    VALUES (v_club, 'MEM-' || to_char(CURRENT_DATE - 30, 'YYYYMMDD') || '-DEMO0003', 'application', 'approved', v_family,
            'Eilidh', 'Mackenzie', 'eilidh.mackenzie@example.com', '+44 7700 900103', 'Bonar Bridge',
            '18.0 / 22.5', 'Alasdair Munro', 'Catriona Gunn',
            'Family of four - both children are in the junior coaching programme.',
            'Family enquiry: two adults and two juniors (ages 12 and 15).',
            ARRAY[v_family], TRUE,
            'Approved at the October committee meeting.', 'demo', NOW() - INTERVAL '2 days',
            NOW() - INTERVAL '25 days', NOW() - INTERVAL '30 days', NOW() - INTERVAL '2 days')
    RETURNING id INTO v_app;
    INSERT INTO public.membership_events (application_id, club, event, actor, note, created_at) VALUES
        (v_app, v_club, 'enquired', 'bot', NULL, NOW() - INTERVAL '30 days'),
        (v_app, v_club, 'email:membership_reply', 'bot', NULL, NOW() - INTERVAL '30 days' + INTERVAL '1 minute'),
        (v_app, v_club, 'submitted', 'guest', NULL, NOW() - INTERVAL '25 days'),
        (v_app, v_club, 'status:under_review', 'demo', NULL, NOW() - INTERVAL '20 days'),
        (v_app, v_club, 'email:membership_under_review', 'demo', NULL, NOW() - INTERVAL '20 days' + INTERVAL '1 minute'),
        (v_app, v_club, 'status:approved', 'demo', 'Approved at the October committee meeting.', NOW() - INTERVAL '2 days'),
        (v_app, v_club, 'email:membership_approved', 'demo', NULL, NOW() - INTERVAL '2 days' + INTERVAL '1 minute');

    -- Margaret Sutherland: enquired while applications were closed - on the waitlist.
    INSERT INTO public.membership_applications
        (club, reference, kind, status, category_id, first_name, last_name, email, phone, message,
         enquiry_summary, recommended_category_ids, consent, created_at, updated_at)
    VALUES (v_club, 'MEM-' || to_char(CURRENT_DATE - 45, 'YYYYMMDD') || '-DEMO0004', 'waitlist', 'waitlisted', v_senior,
            'Margaret', 'Sutherland', 'margaret.sutherland@example.com', '+44 7700 900104',
            'Recently retired to Golspie; would like to join the seniors'' section.',
            'Retired golfer asking about senior membership.',
            ARRAY[v_senior], TRUE, NOW() - INTERVAL '45 days', NOW() - INTERVAL '44 days')
    RETURNING id INTO v_app;
    INSERT INTO public.membership_events (application_id, club, event, actor, note, created_at) VALUES
        (v_app, v_club, 'enquired', 'bot', NULL, NOW() - INTERVAL '45 days'),
        (v_app, v_club, 'email:membership_closed', 'bot', NULL, NOW() - INTERVAL '45 days' + INTERVAL '1 minute'),
        (v_app, v_club, 'waitlisted', 'guest', NULL, NOW() - INTERVAL '44 days'),
        (v_app, v_club, 'email:membership_waitlisted', 'bot', NULL, NOW() - INTERVAL '44 days' + INTERVAL '1 minute');

END $$;

COMMIT;
