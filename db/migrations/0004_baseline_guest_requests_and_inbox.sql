-- Baseline, part 4: guest change requests and the email log / Inbox.
--
-- Folds in migration_add_change_requests.sql and migration_add_email_inbox.sql.
-- Both tables are written by the core API as well as the dashboard.

-- ---------------------------------------------------------------------------
-- booking_change_requests: amendments and cancellations a guest asked for.
-- The manage link itself is stateless (an HMAC of the booking reference), so
-- only the requests are stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_change_requests (
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

DO $$
BEGIN
  ALTER TABLE public.booking_change_requests
    ADD CONSTRAINT booking_change_requests_kind_check CHECK (kind IN ('cancel', 'amend'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.booking_change_requests
    ADD CONSTRAINT booking_change_requests_status_check
    CHECK (status IN ('Pending', 'Approved', 'Declined', 'Applied'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Change requests that arrived by email rather than through the manage link.
ALTER TABLE public.booking_change_requests
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'link',
    ADD COLUMN IF NOT EXISTS email_message_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_change_requests_booking ON public.booking_change_requests (booking_id);
CREATE INDEX IF NOT EXISTS idx_change_requests_open ON public.booking_change_requests (club, status)
    WHERE status = 'Pending';

COMMENT ON TABLE public.booking_change_requests IS
  'Amendments and cancellations asked for by the guest; the club approves unless policy auto-applies';
COMMENT ON COLUMN public.booking_change_requests.auto_applied IS
  'True where club policy let the change take effect without staff approval';
COMMENT ON COLUMN public.booking_change_requests.source IS 'link (manage page) or email (read from a guest email)';

-- ---------------------------------------------------------------------------
-- email_messages: every guest email in and out. review_status = 'open' is the
-- dashboard Inbox.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_messages (
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

CREATE INDEX IF NOT EXISTS idx_email_messages_booking ON public.email_messages (club, booking_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_messages_inbox ON public.email_messages (club, review_status, created_at)
    WHERE review_status = 'open';
CREATE INDEX IF NOT EXISTS idx_email_messages_from ON public.email_messages (club, lower(from_email));

COMMENT ON TABLE public.email_messages IS
  'Every guest email in and out; review_status = open is the dashboard Inbox';
