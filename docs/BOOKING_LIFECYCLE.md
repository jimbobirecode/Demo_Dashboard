# The booking lifecycle ladder

The club's spreadsheet draws a grid — five triggers across, three lanes down,
every cell headed "If Paid" or "If not Paid". What it describes is not a
mailing schedule but a **branching lifecycle**: a booking is taken, a payment
link goes out, and what happens next depends on whether the money arrives and
when. Paid, it climbs a ladder of confirmations to the tee. Unpaid, a different
one towards cancellation — with the way back onto the paid ladder being simply
to pay.

That last part is why this is written as rules rather than as a sequence. The
sheet's "if payment made revert to the if Paid process" needs no jump and no
state machine: the unpaid rungs stop matching the moment the money is in, and
the paid ones start. Nothing anywhere knows a booking "reverted".

## The ladder as built

**Payment phase** — counted from the day the ladder took an interest in the
booking.

| Day | Rung | Sends when |
| --- | --- | --- |
| 0 | `deposit_request` | Nothing paid and no link sent by hand |
| 5 | `deposit_reminder_1` | Still nothing paid |
| 6 | `deposit_reminder_2` | 24 hours before the window closes |
| 7 | `deposit_overdue` | The 7-day window has closed; offers the rescue |
| 8 | `deposit_rescue_48h` | 48 hours before the second deadline |
| 9 | `deposit_rescue_24h` | 24 hours before it |
| 10 | `deposit_cancelled` | **Cancels the booking** |
| on payment | `deposit_receipt` | Anything has been paid — the terms for the next stage |

**Balance phase** — trade only, counted back from the balance deadline. The
sheet gives the visitor flow no balance column, because a visitor pays once.

| Offset | Rung | Sends when |
| --- | --- | --- |
| −10 | `balance_notice` | Deposit in, balance outstanding ("10 days remaining") |
| −2 | `balance_reminder_48h` | Still outstanding |
| −1 | `balance_reminder_24h` | Still outstanding |
| 0 | `balance_cancelled` | **Cancels the booking** |
| 0 | `balance_receipt` | Paid in full — the payment phase closes here |

With the deadline at the sheet's 60 days before play, those land on 70, 62, 61
and 60 days out, exactly as the sheet writes them.

**Communication phase** — both flows, counted from the play date.

| Offset | Rung | Sends when |
| --- | --- | --- |
| −30 | `confirmation` | A payment has been made |
| −10 | `final_details` | A payment has been made |
| +1 | `post_play` | Always — everyone who played is thanked |

Every day count above is a default and every one is overridable; see
`.env.example`.

## The balance deadline is the operator's, not the sheet's

Where a trade account sets `balance_due_days_before_play`, that is the deadline
the ladder uses. The sheet's 60 days is only the fallback for an account that
sets none. This matters because the Bookings drawer and the operator statement
already show a due date derived from those terms — an email saying the balance
is due on the 12th must not sit beside a screen saying the 2nd.

A date set on the booking itself wins over both.

One deliberate departure: `paymentState` falls back to *invoice* terms (the
play date plus 30 days) for an account with no term of its own. That is right
for billing and wrong for a deadline — it would put the balance deadline a
month after the round was played — so the ladder does not use it.

## The four guards

These are the parts worth reviewing, because they are what stop a mechanism
that emails cancellations from doing something irreversible.

**1. A ledger, not fifteen more timestamps.** `booking_trigger_sends`
(migration `0012`) holds one row per booking per rung. The rungs are
configuration and a club will add more; each would otherwise be another
column, another entry in `BOOKING_COLUMNS` and another migration. The ledger
also records what a timestamp cannot: that a rung was *skipped* because the
booking was already paid, *superseded* because the run reached it late, or
*held* because a person has to decide.

The no-double-send guarantee is the partial unique index, not application
code:

```sql
CREATE UNIQUE INDEX idx_booking_trigger_sends_once
    ON booking_trigger_sends (club, booking_id, rung)
  WHERE outcome <> 'failed';
```

Failures sit outside it on purpose, so a rung that failed to send is tried
again. The ledger row is written *before* the send, so a crash mid-send leaves
a claim that is recorded as failed and retried — never a second cancellation
notice.

**2. A catch-up horizon (3 days).** Without it the first run after switching on
would work through every booking whose deadlines passed months ago and email
all of them at once — a year of "your booking is cancelled" in one morning. A
rung that fell due longer ago than the horizon is recorded as superseded and
never sent. `BOOKING_TRIGGERS_CATCH_UP_DAYS` widens it.

**3. Collapsing — at most one email per booking per run.** A booking switched
on mid-ladder, or one whose run was missed for a week, has several rungs
behind it. Sending them all would deliver a nudge, a warning and a
cancellation in the same breath. The furthest-along rung by date is the only
true one — it is the booking's actual situation — and the rest are recorded as
superseded, which is also what stops an expired warning arriving a day late.

A consequence worth knowing: a round that has already been played is thanked,
not cancelled, even if the deposit never arrived. The later rung wins.

**4. Three switches, all off by default, and they nest.**

| Switch | Off (the default) | On |
| --- | --- | --- |
| `BOOKING_TRIGGERS_ENABLED` | Nothing runs, nothing is recorded | The ladder evaluates |
| `BOOKING_TRIGGERS_DEADLINES` | No rung that cancels is in the ladder at all | Deadlines count |
| `BOOKING_TRIGGERS_SCHEDULE` | Runs only when a person asks | Runs every `BOOKING_TRIGGERS_MINUTES` |
| `BOOKING_TRIGGERS_AUTO_CANCEL` | A lapse is **held** for a person; nothing emailed | The ladder cancels |

Nesting means deadlines do nothing until the ladder is on, the schedule does
nothing until deadlines are, and nothing is cancelled until auto-cancel is. A
club can therefore watch what the ladder *would* do for a week before it does
any of it.

## Switching it on safely

1. Set `BOOKING_TRIGGERS_ENABLED=true` and nothing else. Read a dry run:

   ```
   POST /api/booking-triggers/preview
   ```

   It walks every eligible booking, sends nothing and writes nothing.

2. Configure the templates. `GET /api/booking-triggers` lists every rung with
   `configured: true|false`. A rung with no template is skipped and reported,
   never recorded, so it starts working the run after you set one. Each rung
   looks for `SENDGRID_TEMPLATE_<RUNG>` (e.g.
   `SENDGRID_TEMPLATE_DEPOSIT_OVERDUE`), then falls back to
   `SENDGRID_TEMPLATE_LIFECYCLE`.

3. Turn on `BOOKING_TRIGGERS_DEADLINES`, then `BOOKING_TRIGGERS_SCHEDULE`.

4. Leave `BOOKING_TRIGGERS_AUTO_CANCEL` off until the held list has been read
   for a while. `GET /api/booking-triggers/held` is that list — **if nobody
   reads it, the ladder has quietly stopped doing the last thing the sheet asks
   of it.**

## Two decisions taken against the sheet

**"Booking removed" is a status and a note, never a delete.** The row is the
evidence behind the cancellation — what was owed, what was chased, and on
which days. A club that deletes it keeps the consequence and throws away the
justification. The booking becomes `Cancelled`, stamped `updated_by =
'lifecycle'`, with a note naming the reason and the rung:

> Cancelled by the booking lifecycle on 2026-01-11: no deposit was received
> within the payment window (deposit_cancelled).

`changes.js` already cancels the same way.

**The visitor dunning is an extrapolation.** The sheet writes the chasing
cadence out only for the operator flow. The visitor columns have the headers —
"If Paid", "If not paid" — and no text under them. Both flows therefore run the
same ladder, and `BOOKING_TRIGGERS_VISITOR_DUNNING=false` declines it for
visitors without losing them the receipt and arrival details the sheet *does*
spell out. Trade bookings are still chased.

A third, smaller reading: the 30- and 10-day emails require **a** payment
rather than full payment, so a part-paid booking still gets its arrival
information. The sheet's header says only "If Paid"; the cost of reading it the
other way is a guest arriving without knowing where to go.

## Where it lives

| File | What it holds |
| --- | --- |
| `server/src/lib/booking-triggers-domain.js` | The ladder and the rules. Pure: no database, no clock, no API key. |
| `server/src/lib/booking-triggers.js` | The runner — reads, sends, writes the ledger, cancels. Decides nothing. |
| `server/src/routes/booking-triggers.js` | Config, dry run, run now, the held list, one booking's history. |
| `db/migrations/0012_booking_lifecycle_triggers.sql` | The ledger, the unique index, `bookings.lifecycle_started_at`. |
| `server/test/booking-triggers-domain.test.js` | Every rung, both flows, the revert, collapsing, the horizon, the switches. |

## The anchor

Payment-phase rungs are measured from `bookings.lifecycle_started_at`, written
once and never moved. Not `updated_at`, which moves on every edit, and not
`created_at`, which can be months before the club committed to the booking. A
booking that already had a payment link sent by hand is anchored on
`payment_link_sent_at` instead — the link is the day-0 rung, and a club that
sent one last Tuesday should be five days into the ladder, not starting it now.

All day arithmetic uses `todayInClubZone()`. A run near midnight UTC would
otherwise fire day 7 on day 6, which for an overdue notice is the difference
between a warning and a cancellation.
