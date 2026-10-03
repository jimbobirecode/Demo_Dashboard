-- Bring an existing bookings table up to date with the dashboard + email bot.
-- Safe to run more than once; only adds what is missing.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_name                VARCHAR(255);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contact_phone             VARCHAR(50);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS caddie_requirements       VARCHAR(100);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS special_requests          TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS form_submitted_at         TIMESTAMP;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hotel_required            BOOLEAN DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hotel_checkin             DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hotel_checkout            DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lodging_nights            INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lodging_rooms             INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lodging_room_type         VARCHAR(100);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lodging_preferences       TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lodging_cost              DECIMAL(10,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resort_fee_per_person     DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resort_fee_total          DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS golf_dates                TEXT[];
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS golf_courses              TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS selected_tee_times        JSONB;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pre_arrival_email_sent_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS post_play_email_sent_at   TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_confirmed_at     TIMESTAMP;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMP;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_by                VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_bookings_club_status ON bookings (club, status);
CREATE INDEX IF NOT EXISTS idx_bookings_club_date   ON bookings (club, date);

CREATE TABLE IF NOT EXISTS dashboard_users (
    id                   SERIAL PRIMARY KEY,
    username             VARCHAR(255) UNIQUE NOT NULL,
    password_hash        TEXT,
    temp_password        TEXT,
    customer_id          VARCHAR(255),
    full_name            VARCHAR(255),
    is_active            BOOLEAN DEFAULT TRUE,
    must_change_password BOOLEAN DEFAULT FALSE,
    last_login           TIMESTAMP
);

CREATE TABLE IF NOT EXISTS waitlist (
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

-- Demo login for the dashboard (customer_id must match CLUB_PROFILE's club id)
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
