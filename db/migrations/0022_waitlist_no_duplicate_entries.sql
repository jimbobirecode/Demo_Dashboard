-- One live waitlist entry per guest, per date, per party size.
--
-- County Louth's list came over with 118 entries, of which only 83 were
-- distinct requests. One party -- golf@outpostoverseas.com, 28 April 2027,
-- four players -- was on it fourteen times. Every copy in every group was
-- identical in all of status, preferred time, priority and notes, and no copy
-- held a conversion, so the duplicates carried nothing the first copy did not;
-- they were simply the same request recorded again each time the old system
-- saw the same email.
--
-- Two parts: clear what is already there, then stop it happening again.
--
-- The index is PARTIAL, on live entries only. A party that waited, was turned
-- down and asks again next season is making a new request, not repeating an
-- old one, so a Cancelled or Converted entry must not block it. Open means
-- Waiting or Notified, which is what OPEN_STATUSES says in
-- server/src/lib/waitlist-domain.js -- if that list ever changes, this index
-- has to change with it.
--
-- An entry with no date is never treated as a duplicate of anything: there is
-- nothing to compare it on, and two undated entries from the same guest may
-- well be two real requests.

-- ---------------------------------------------------------------------------
-- Guards, as in 0015-0021. The helpers live in pg_temp and are dropped at the
-- end of the file.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.ensure_index(name text, ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
    EXECUTE ddl;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Remove the redundant copies, oldest kept.
--
-- The oldest is kept because it carries the request's real age, which is what
-- the list is ordered and reported on.
--
-- Two things this will not do, so that a group which is NOT purely redundant
-- survives untouched for a person to look at:
--   * it skips any group where some copy became a booking, so no link from a
--     waitlist entry to a booking can be severed here;
--   * it skips any group whose copies disagree about anything a person might
--     have typed -- status, preferred time, priority or notes -- because then
--     they are not copies.
-- On a database with no duplicates, which is every fresh one, it does nothing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  removed integer;
BEGIN
  WITH groups AS (
    -- One row per (club, guest, date, party size), with everything needed to
    -- decide whether its members really are copies of each other.
    -- count(DISTINCT ...) is a plain aggregate here: Postgres has no DISTINCT
    -- for window functions, which is why this is a GROUP BY and not an OVER.
    SELECT club,
           lower(guest_email) AS guest,
           requested_date,
           players,
           count(*) AS copies,
           count(converted_booking_id) AS conversions,
           count(DISTINCT status) AS statuses,
           count(DISTINCT coalesce(preferred_time, '')) AS times,
           count(DISTINCT coalesce(notes, '')) AS notes_seen,
           count(DISTINCT coalesce(priority, -1)) AS priorities
      FROM public.waitlist
     WHERE requested_date IS NOT NULL
     GROUP BY club, lower(guest_email), requested_date, players
  ),
  redundant AS (
    SELECT w.waitlist_id,
           row_number() OVER (
             PARTITION BY w.club, lower(w.guest_email), w.requested_date, w.players
             ORDER BY w.created_at ASC, w.waitlist_id ASC) AS copy_number
      FROM public.waitlist w
      JOIN groups g
        ON g.club = w.club
       AND g.guest = lower(w.guest_email)
       AND g.requested_date = w.requested_date
       AND g.players IS NOT DISTINCT FROM w.players
     WHERE g.copies > 1
       AND g.conversions = 0
       AND g.statuses = 1
       AND g.times = 1
       AND g.notes_seen = 1
       AND g.priorities = 1
  )
  DELETE FROM public.waitlist w
   USING redundant r
   WHERE w.waitlist_id = r.waitlist_id
     AND r.copy_number > 1;

  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed > 0 THEN
    RAISE NOTICE 'removed % duplicate waitlist entr(ies); the oldest of each was kept', removed;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Stop it happening again.
--
-- A unique index cannot be created while anything already breaks it, and what
-- would break it is a LIVE group that step 1 deliberately left alone because
-- its copies disagree. County Louth has none: every duplicate group there is
-- copies all the way down. Another install might not be so lucky.
--
-- Warned rather than fatal, as in 0007: a club should not be locked out of its
-- dashboard by two waitlist rows. But the absence of this index is invisible
-- afterwards, and a guard nobody knows is missing is worse than no guard -- so
-- the warning names the exact entries standing in the way, rather than saying
-- only that it did not work.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  blocking text;
BEGIN
  SELECT string_agg(format('%s / %s / %s players (%s entries)', guest, requested_date, players, n), '; ')
    INTO blocking
    FROM (
      SELECT lower(guest_email) AS guest, requested_date, players, count(*) AS n
        FROM public.waitlist
       WHERE status IN ('Waiting', 'Notified') AND requested_date IS NOT NULL
       GROUP BY club, lower(guest_email), requested_date, players
      HAVING count(*) > 1
    ) AS clashes;

  IF blocking IS NOT NULL THEN
    RAISE WARNING 'uq_waitlist_live_request was NOT created: these live waitlist entries are already duplicated and differ from each other, so they need a person -- %', blocking;
    RETURN;
  END IF;

  PERFORM pg_temp.ensure_index('uq_waitlist_live_request',
    $ddl$CREATE UNIQUE INDEX uq_waitlist_live_request
           ON public.waitlist (club, lower(guest_email), requested_date, players)
        WHERE status IN ('Waiting', 'Notified') AND requested_date IS NOT NULL$ddl$);
END $$;

DROP FUNCTION pg_temp.ensure_index(text, text);
