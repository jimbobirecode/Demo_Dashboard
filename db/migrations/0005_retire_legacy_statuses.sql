-- Retired booking statuses.
--
-- The pipeline is Inquiry -> Requested -> Booked. 'Pending' is the
-- Streamlit-era spelling of 'Inquiry' and 'Confirmed' a retired stage that
-- already counts as 'Booked': both the dashboard (bookings-domain.js) and the
-- core API treat each pair as the same status, so rewriting the stored value
-- changes nothing a user can see. Folds in the status updates from
-- migration_add_hotel_and_workflow.sql and migration_retire_confirmed_status.sql.
--
-- Safe on a live database: it only touches rows still carrying a retired
-- spelling, and is a no-op once they are gone.

UPDATE public.bookings SET status = 'Inquiry' WHERE status = 'Pending';
UPDATE public.bookings SET status = 'Booked' WHERE status = 'Confirmed';
