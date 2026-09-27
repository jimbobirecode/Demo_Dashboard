-- Payment receipts and the pre-play clock.
--
-- When Stripe reports a payment the dashboard emails the guest a receipt and
-- starts the booking's pre-play clock: from then on the booking is listed for
-- the pre-arrival welcome on Guest Emails. Marking a payment Paid or Deposit
-- paid by hand starts the clock too.
--
-- Run after migration_add_stripe_payment_links.sql. Safe to run more than
-- once; the dashboard picks the columns up within 30 seconds.

BEGIN;

ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id    VARCHAR(255),
    ADD COLUMN IF NOT EXISTS stripe_last_payment_amount  NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS payment_receipt_sent_at     TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS pre_play_clock_started_at   TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.bookings.stripe_payment_intent_id IS 'Stripe reference (pi_...) of the last payment, quoted on the receipt';
COMMENT ON COLUMN public.bookings.stripe_last_payment_amount IS 'What the last Stripe payment was for, so its receipt can be resent';
COMMENT ON COLUMN public.bookings.payment_receipt_sent_at IS 'When the receipt for the last payment was emailed; NULL means it has not been';
COMMENT ON COLUMN public.bookings.pre_play_clock_started_at IS 'When payment started the pre-play email sequence';

-- Bookings already paid before this migration have started their clock.
UPDATE public.bookings
   SET pre_play_clock_started_at = COALESCE(stripe_paid_at, NOW())
 WHERE pre_play_clock_started_at IS NULL
   AND payment_status IN ('Paid', 'Deposit paid');

COMMIT;
