# Booking Status: the booking lifecycle ladder

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

## Agreeing with the tour operator module

A visitor pays the club directly; a tour operator pays on an account whose
terms the operator module already holds — deposit percentage, when the deposit
and the balance fall due, whether the account is active. The ladder reads
those rather than keeping a second copy, and three things follow.

**A trade booking is chased towards the account's own deposit date.** The
deposit rungs count from the deposit deadline, not from the booking: for a
visitor that is the sheet's window from the day the booking was made, and for
an account with `deposit_due_days_before_play` it is that date. The reminders
land two days and one day before *it*, the final notices after it. An
operator agreed at "90 days before play" is reminded on day −92 and −91,
warned on −90, and stopped on −87 — the same dates the operator drawer shows.

**Money goes to the account, the round goes to the guest.** The operator
module's own words for the contact email are "where reminders are sent", so
the payment and balance phases go there; the confirmation, arrival details
and thank-you go to whoever is playing. An account with no contact email
falls back to the guest, and the Settings page says so in red.

**An account can be taken out of chasing.** `tour_operators.auto_chase`
(migration `0014`, default on, under *Chasing* in the operator form) is for an
account that pays by invoice on its own cycle: off, its bookings still get the
run-up-to-the-tee emails and lose the money phases, and a lapse on them is
never cancelled by the ladder. A retired account is never chased, as the
module always promised.

The Settings page reports the trade book as the ladder sees it — how many
accounts set their own dates, how many are not chased, how many have no
contact email — and sends the reader to Tour Operators for the per-account
terms rather than offering a second copy of them.

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

**4. Four switches, all off by default, and they nest.**

They live in **Settings → Chasing unpaid bookings**, per club, and an
administrator changes them. Nothing here is a deployment setting any more.

A club is not asked to set four nested flags. It sees one switch — **Chase
unpaid bookings** — and, under it, one choice about a booking that never pays:
**Stop and ask me** (recommended) or **Cancel it and tell them**. The switch
moves `enabled`, `deadlines` and `scheduled` together; the choice is
`autoCancel`. A dry run needs none of them, so *Preview today* on the Booking
Lifecycle page works whether chasing is on or off, and that is how a club
reads the ladder before switching it on.

Choosing to cancel asks a second time, because it is the one setting whose
first effect a guest reads.

## Where a club changes it

**Settings → Chasing unpaid bookings.** Reading is open to anyone signed in;
saving is an administrator's.

The timings are written as sentences with the units in them — "Ask for the
deposit within [7] days of the booking" — rather than as a grid of labelled
boxes, because "First reminder: 5" means nothing without "days after what".

Beside them, **What a guest gets** draws the whole schedule out as two
stories, *If they do not pay* and *If they pay*, and follows the numbers as
they are edited. It is the part that does the explaining, and it changes with
the choice above: pick "never cancel" and the final warnings and the ending
disappear from it, because they would not happen.

An order that cannot work is refused before it can be saved — a reminder after
the deadline it reminds about, or a final deadline with no room for the 48- and
24-hour warnings — and said in the same words on the page and at the server.

## Switching it on safely

1. Choose **Show me what you would send, but send nothing**. Read a dry run
   from **Booking Status → Preview today**: it walks every eligible
   booking, sends nothing and writes nothing.

2. Read the emails. All sixteen are written and ready — nothing to configure
   — and the wording is in `server/src/lib/lifecycle-emails.js`. A club that
   wants its own can set `SENDGRID_TEMPLATE_<RUNG>` (e.g.
   `SENDGRID_TEMPLATE_DEPOSIT_OVERDUE`) or one `SENDGRID_TEMPLATE_LIFECYCLE`
   for all of them; see **The emails** below.

3. Move to **Send reminders, then stop and ask me**.

4. Stay there until *Waiting on you* on the Booking Status page has been
   read for a while — **if nobody reads it, the ladder has quietly stopped
   doing the last thing the sheet asks of it.** Only then consider the last
   choice.

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

## The emails

All sixteen are written in `server/src/lib/lifecycle-emails.js` and sent in the
club's own branding, exactly as the payment link and receipt emails are. There
is nothing to set up: a club that switches the ladder on today starts sending
them today.

Three rules the copy keeps, and they are worth keeping if anybody rewrites it:

**It never threatens what the club has not switched on.** The warnings and the
cancellation only exist in the modes that can stop a booking, so an email never
promises a consequence that cannot happen.

**Every chasing email carries the payment link.** One that says a booking is at
risk and offers no way to pay is a complaint, not a reminder. There is a test
for this.

**It calls the money what it is.** A trade account owing 25% up front is asked
for a *deposit*; a visitor owing all of it is asked for a *payment*. Being
asked for "a deposit of €1,000" on a €1,000 round is how somebody pays twice,
or rings to ask.

Every email goes onto the booking's own conversation as well as into the
ledger, so the drawer shows what the guest was actually told, in with
everything else they have been sent.

### Using your own wording

Per-rung template beats `SENDGRID_TEMPLATE_LIFECYCLE`, which beats the
built-in email. `sendgrid-templates/booking-lifecycle.html` is a starting
point, and lists every merge field — including `headline`, `button_url` and
`button_label`, which carry our copy into your layout if you want the words but
not the design.

## One page for chasing

The page is **Booking Status** (`/booking-status`; the old `/lifecycle` and
`/reminders` addresses redirect): what is waiting on a person, a dry run, the
sequence. The Operator Reminders page it stood beside is gone — one digest
email per account, picked and sent by hand, was the same job as the ladder's
chasing, done manually. The ladder asks each trade booking for its deposit and
its balance at the account, on the account's own dates, and writes every send
to the ledger.

## Two voices

A visitor pays for their own round, so the chase is written to the person
playing: "your round", "your tee time", "Hi Ann". A tour operator's booking is
paid for by the account, and every payment- and balance-phase email goes to
the account's contact — who holds a dozen of these at once, knows the terms,
and does not want to be addressed as if they were turning up with their clubs.
So each of those thirteen rungs carries a second version written to the trade
partner: the guest named in the third person, the account's own due date, the
terms stated as terms, Guest and Account rows at the top of the table, and no
manage-booking link (that is the guest's). The communication rungs — the
confirmation, the final details, the thank you — go to the guest whoever pays,
and have one voice.

Which voice is decided per email by who it is actually addressed to, not by the
ladder alone: an account with no contact email falls back to the guest, and the
guest is then written to as a guest.

## Where it lives

| File | What it holds |
| --- | --- |
| `server/src/lib/booking-triggers-domain.js` | The ladder and the rules. Pure: no database, no clock, no API key. |
| `server/src/lib/booking-triggers.js` | The runner — reads, sends, writes the ledger, cancels. Decides nothing. |
| `server/src/routes/booking-triggers.js` | Config, dry run, run now, the held list, one booking's history. |
| `db/migrations/0012_booking_lifecycle_triggers.sql` | The ledger, the unique index, `bookings.lifecycle_started_at`. |
| `server/src/lib/lifecycle-emails.js` | What each rung actually says. Pure — the copy is readable in a test. |
| `server/test/lifecycle-emails.test.js` | Every email is complete, nothing half-interpolated, every warning offers a way out. |
| `sendgrid-templates/booking-lifecycle.html` | Optional: one template for a club that wants its own layout. |
| `server/test/booking-triggers-domain.test.js` | Every rung, both flows, the revert, collapsing, the horizon, the switches, and what a club may save. |
| `db/migrations/0013_lifecycle_settings.sql` | `club_settings.lifecycle_settings`, the club's own copy of all of it. |
| `web/src/components/LifecycleSettings.jsx` | The settings form, and `modeFor`: the five choices over the four flags. |
| `web/src/components/LifecycleTimeline.jsx` | "What a guest gets" — the schedule drawn from the draft settings. |
| `web/src/pages/Lifecycle.jsx` | The operational page: what is waiting, what would happen today, the ladder. |

## Settings, environment, defaults

In that order. A club's saved setting wins; where it has saved nothing the
environment is used; where neither says anything the spreadsheet's own number
stands. That order is what keeps an install that was configured entirely from
the environment working exactly as it did — it inherits, and only starts
diverging when somebody edits it in the dashboard.

Two things stay the deployment's, because they are about the server rather
than the club: `BOOKING_TRIGGERS_BATCH` (how many bookings one pass reads) and
`BOOKING_TRIGGERS_MINUTES` (how often the process wakes). `BOOKING_TRIGGERS=off`
switches the whole feature off for a deployment and overrules every club.

The scheduler now starts regardless and asks the clubs on each tick whether
anything should happen — one indexed query when nobody is interested. That is
the point of moving the switches: a club that turns the ladder on on a Tuesday
cannot be made to wait for the next deploy.

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
