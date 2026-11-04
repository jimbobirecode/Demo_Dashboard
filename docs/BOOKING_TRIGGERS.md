# The booking trigger workflow

Every confirmed booking climbs a ladder of timed emails, from the payment link
that secures it to the thank you the day after play. This is that ladder: what
each rung says, when it falls due, what stops it firing twice, and the switches
each club sets to decide how much of it runs on its own.

Implemented in:

| File                                            | What it holds                                    |
| ----------------------------------------------- | ------------------------------------------------ |
| `server/src/lib/booking-triggers-domain.js`     | the ladder, the dates, the conditions — all pure |
| `server/src/lib/booking-trigger-emails.js`      | what each rung says                              |
| `server/src/lib/booking-trigger-runner.js`      | one pass: read, decide, send, record             |
| `server/src/lib/booking-trigger-sweep.js`       | the unattended schedule                          |
| `server/src/lib/booking-trigger-settings.js`    | each club's own switches and deadlines           |
| `server/src/routes/booking-triggers.js`         | the API the pages call                           |
| `db/migrations/0026_booking_trigger_workflow.sql` | the ledger of rungs already climbed            |
| `db/migrations/0027_trigger_settings_and_auto_chase.sql` | the per-club settings, and the accounts' chase switch |
| `web/src/pages/BookingStatus.jsx`               | the page                                         |
| `web/src/pages/Settings.jsx`                    | where a club sets its own deadlines and switches |

## The two ladders

Which ladder a booking is on is decided by its trade account, attributed the
way the Tour Operators page attributes bookings: an assignment or a registered
sending domain, never a name that turned up in the body of an email. A booking
with no such evidence is a visitor.

The difference is the balance phase. A trade partner pays a deposit to secure
the tee sheet and settles the balance 60 days out; a visitor pays once. So the
70/62/61/60-day balance rungs belong to the operator ladder only. Everything
else — the deposit chase, the confirmations, the arrival details, the thank you
— is shared.

## The ladder, rung by rung

Days in the first column are counted **from the day the booking was confirmed**;
days in the second are counted **back from the play date**.

| Trigger   | Step                       | When                     | Applies when        | Flow     |
| --------- | -------------------------- | ------------------------ | ------------------- | -------- |
| Trigger 1 | `deposit_request`          | booking + 0 days         | nothing paid        | both     |
| Trigger 1 | `deposit_reminder`         | booking + 5 days         | nothing paid        | both     |
| Trigger 1 | `deposit_final_notice`     | booking + 6 days         | nothing paid        | both     |
| Trigger 2 | `deposit_overdue`          | booking + 7 days         | nothing paid        | both     |
| Trigger 3 | `deposit_rescue_48h`       | booking + 8 days         | nothing paid        | both     |
| Trigger 3 | `deposit_rescue_24h`       | booking + 9 days         | nothing paid        | both     |
| Trigger 3 | `deposit_lapsed`           | booking + 10 days        | nothing paid        | both     |
| Payment 2 | `deposit_receipt`          | the day money arrives    | secured by a payment| both     |
| Trigger 2 | `balance_notice`           | play − 70 days           | deposit in, balance owed | trade |
| Trigger 3 | `balance_rescue_48h`       | play − 62 days           | balance owed        | trade    |
| Trigger 3 | `balance_rescue_24h`       | play − 61 days           | balance owed        | trade    |
| Trigger 3 | `balance_lapsed`           | play − 60 days           | balance owed        | trade    |
| Trigger 3 | `booking_confirmed`        | play − 60 days           | paid in full        | both     |
| Trigger 4 | `pre_arrival_confirmation` | play − 30 days           | secured by a payment| both     |
| Trigger 5 | `final_details`            | play − 10 days           | secured by a payment| both     |
| Post play | `post_play`                | tee time + 24 hours      | any                 | both     |

The deadlines are a shape, not sixteen numbers: `TRIGGER_DEPOSIT_DAYS=14` moves
the 24-hour notice to day 13, the overdue notice to day 14 and the cancellation
to day 17. See `.env.example` for every setting.

### How the branches work

The conditions are what make this a workflow rather than a mailing schedule.
`deposit_reminder` applies only while nothing has been paid; `deposit_receipt`
only once something has. So a guest who pays on day 6 stops matching every
remaining rung of the chase ladder and starts matching the paid one — which is
the spec's "if payment made, revert to the if-paid process", falling out of the
rules rather than being coded as a jump.

The same at 60 days. A trade booking still owing its balance matches
`balance_lapsed` (cancel); one that has paid matches `booking_confirmed` (thank
you). The two sit on the same date and are mutually exclusive by condition.

### What counts as paid

- **nothing paid** — `total` is more than zero, `amount_paid` is zero, and the
  payment status is not one staff set to Paid or Deposit paid.
- **secured** — money has been received, or staff marked it received. A status
  of `Paid` with no figure recorded counts: that is somebody saying it is
  settled, and the ladder must not then chase it.
- **paid in full** — nothing is outstanding.
- A booking with **no price** is never chased. There is nothing to ask for.
- A booking **outside the payment ledger** (see `PAYMENTS_TRACKED_FROM`) is
  never chased either. "Unpaid" on a booking taken before the club started
  recording payments is the arithmetic talking, and the email would demand money
  that may have arrived by bank transfer a year ago. It still climbs the
  communication ladder, which is about the round rather than the bill.

### The chase ladder needs a payment ledger

This follows from the rule above and is worth saying on its own, because it is
the first thing that will look broken. With `PAYMENTS_TRACKED_FROM` unset, **no
booking is in the ledger**, so no booking has a balance, so none of the deposit
or balance rungs match anything and the Due list is empty however many unpaid
bookings the club has.

That is correct — a club that records no payments cannot run a payment chase, and
guessing would mean emailing demands for money that may well be in the bank —
but it is not obvious from an empty page, so the Booking Status page says it in as many
words and names the setting. Set `PAYMENTS_TRACKED_FROM` to the day the club
started recording payments, or `all` for the whole history.

The communication rungs (`pre_arrival_confirmation`, `final_details`,
`post_play`) do not need the ledger: they are about the round, and they run
either way.

## The guards

Four things stop this engine doing damage, and they are the parts to read before
changing anything.

**The ledger.** Every rung that reaches a settled outcome is written to
`booking_trigger_sends`, guarded by a partial unique index on
`(club, booking_id, step)`. A rung cannot be climbed twice, whoever runs the
pass and however often two runs overlap. A `failed` row is outside the index on
purpose, so a refused send is retried next time.

**The catch-up horizon.** A rung is due only within `TRIGGER_CATCH_UP_DAYS`
(3) of its date. Most of this ladder's dates are in the past for most of a
club's table, so without the horizon the first run after switching the workflow
on would email a year of history its own deadlines. Older rungs are reported as
`missed` on the page, where a person can read them and decide, and are never
sent unprompted.

**Collapsing.** At most one email per booking per run. A booking whose deposit
ladder has run away from it has several rungs inside the horizon at once, and a
guest must not receive a reminder and a final notice in the same minute. The
furthest-advanced rung goes out; the ones it passed are recorded as
`superseded`, so they are climbed rather than left to fire tomorrow as a warning
about a deadline that has already expired.

**The two emails that predate the engine.** The post-play thank you is already a
campaign on the Guest Emails page and the receipt is already sent by the Stripe
webhook. Both write a stamp on the booking, and the engine reads those stamps as
the rung being climbed — so switching the workflow on does not send a guest a
second copy of an email they have already had.

## Before it will run at all: the migration

Migrations are applied deliberately with `npm run migrate` before a deploy,
never at boot ([MIGRATIONS.md](MIGRATIONS.md) and the note in `render.yaml`
explain why). So the first state of this feature on a real install is code
deployed against a database with no ledger table, and every endpoint that reads
or writes it fails.

Run it:

```
npm run migrate
```

Until that is done the Booking Status page shows a banner naming the table, the
migration and that command, and the endpoints answer `409` rather than `500`:
this is a database one step behind, not a fault to investigate. `/config` keeps
working, so the page can render the message instead of going blank. The
scheduled pass says the same thing once per pass and stands down rather than
repeating it per club.

Only Postgres' "relation does not exist" is translated this way. Any other
database fault keeps its own 500, so a real outage is not reported to the club
as a migration they have already run.

## The switches, and whose they are

Three decisions, each a switch of its own:

| On the Settings page           | What it means                                              |
| ------------------------------ | ---------------------------------------------------------- |
| **Chase unpaid bookings**      | these are our deadlines, and send them daily, unattended   |
| **Stop and ask me** (default)  | a booking nobody paid for is listed for a person to decide |
| **Cancel it and tell them**    | ...or cancelled by the ladder, and the guest told          |

Since migration 0027 they belong to the club, not the deployer: an
administrator sets them under **Settings**, they are saved per club in
`club_settings.trigger_settings`, and the schedule reads them fresh on every
pass, so a Save takes effect at the next tick rather than the next deploy. The
deadlines live beside them — the deposit window, the day of the first reminder,
the grace before cancellation, the balance notice and deadline, the
confirmation and arrival-details days, the thank-you hours, and the catch-up
horizon — with the same orderings enforced on save that the ladder depends on
(the reminder before the deadline, at least two days' grace for the 48- and
24-hour notices, the notice before the balance is due, the details after the
confirmation).

Underneath, the page's one switch moves two flags together — `enabled` and
`automatic` — because a club that chases wants it done without pressing a
button every morning. The two are still separate in the API and in the
environment, for an install that wants to read the Booking Status page for a
week before handing it to the schedule.

The environment is the fallback and the floor. Every setting a club has not
saved inherits its `TRIGGER_*` variable (see `.env.example`), so an install
configured by environment carries on exactly as it did until somebody presses
Save. And `TRIGGER_WORKFLOW=false` — set, as against unset — is a kill switch
no club setting can lift: the page says so, the schedule stands down for every
club, and it is how a staging copy of a live database is kept from emailing
real guests.

Cancelling is the only rung that changes the club's own tee sheet rather than
somebody's inbox, and an apology does not undo it, which is why it is a choice
of its own with a second confirmation on the page. With it off, a lapsed
booking is listed as `Waiting on a person`, no cancellation email goes out —
the email would be announcing a cancellation that has not happened — and
nothing is written to the ledger, so it stays on the list until somebody deals
with it.

Cancelling sets the status to `Cancelled` and appends a line to the booking's
note. **It never deletes the row.** The club's record of a round that was booked
and lost is the evidence behind the cancellation, and it carries the money, the
correspondence and the audit trail.

## Trade accounts: their terms, their inbox, their switch

A tour operator's booking is chased on the account's own terms, read from the
Tour Operators page rather than duplicated here:

- **Deposit due (days before play)**, where set, slides the whole deposit
  ladder so that its deadline rung lands on that date, with the reminders and
  the grace keeping their distance from it. Nothing is asked for before the
  booking was made.
- **Balance due (days before play)**, where set, moves the balance notice, the
  48- and 24-hour warnings, the balance deadline and the thank-you that closes
  it. The default under Settings applies to accounts that leave it blank.
- **Money goes to the account.** Every payment-phase email — the link, the
  chases, the balance notice, the cancellation — goes to the account's contact
  email, which is what the operator form already calls "where reminders are
  sent". The confirmation, the arrival details and the thank you go to the
  guest, who is the one playing. An account with no contact email falls back
  to the guest, and the Settings page says which accounts those are.
- **Chase this account for payment** is the account's own switch (migration
  0027, `tour_operators.auto_chase`). Off, its bookings' payment rungs are
  listed as `This account is not chased` and never fire; the guest's arrival
  emails still run. A retired account is never chased, as it always was.

## What each rung says

Every step has a built-in branded email in `booking-trigger-emails.js` — the
same header, footer and detail table as the payment link and the receipt, and
readable with images off. That is the opposite default from the two guest
campaigns, which refuse to send without a SendGrid template: sixteen steps is
sixteen templates to build before anything works at all, and the ladder has to
be usable on the day it is switched on.

A club that wants its own design for a step sets that step's template id
(`SENDGRID_TEMPLATE_TRIGGER_FINAL_DETAILS` and so on) and the built-in email is
never used for it. The merge fields are the same either way, so a template
written against one step renders for the others.

### Two voices

A visitor pays for their own round, so the chase is written to the person
playing: "your tee time", "your booking", "Hi Ann". A tour operator's booking
is paid for by the account, and every payment-phase email goes to the account's
contact — who holds a dozen of these at once, knows the terms, and does not want
to be addressed as if they were turning up with their clubs. So each of the
twelve payment steps carries a second version written to the trade partner:
"Dear Mairéad", the guest named in the third person, the account's own due date
(`due_date`, `balance_due_date`) rather than "within 7 days", the terms stated
as terms, a Guest and an Account row at the top of the table, and no
manage-booking link (that is the guest's). The communication steps — the
confirmation, the arrival details, the thank you — go to the guest whoever
pays, and have one voice.

Which voice is decided per email by who it is actually addressed to
(`audience` in the merge data), not by the ladder alone: an account with no
contact email falls back to the guest, and the guest is then written to as a
guest. A SendGrid template gets `audience`, `salutation`, `operator_name`,
`operator_contact_name` and `balance_due_date` to do the same.

These emails are what the old Operator Reminders page used to do by hand —
one email per account listing what it owed — and that page is gone: the
ladder chases each booking on its own date, at the account, and records it in
the ledger.

## Payment links

`deposit_request` and `balance_notice` mint a Stripe link; the chases in between
reuse whatever link is current on the booking, because they are asking for the
same money. The amount is the next unsettled milestone under the booking's own
credit terms — the deposit while it is outstanding, the balance after — so the
figure in the email matches the word next to it.

If a send fails after a link was minted, the link is deactivated again: nobody
has it, so it must not stay payable. If an earlier link asked for a different
amount it is switched off when the new one goes out, so a guest cannot pay both.

Where Stripe is not configured the emails still go, asking the guest to reply
for a payment link rather than showing a dead button.

## The API

| Method | Path                                          | What it does                               |
| ------ | --------------------------------------------- | ------------------------------------------ |
| GET    | `/api/booking-triggers/config`                | the ladder, the deadlines, the switches, as this club has them |
| GET    | `/api/booking-triggers/settings`              | the Settings page's view: saved, inherited, defaults, bounds, the trade book |
| PUT    | `/api/booking-triggers/settings`              | change them, as a patch (admin)            |
| GET    | `/api/booking-triggers/pending?scope=`        | `due`, `missed` or `all` (playing from the last 30 days onwards) |
| GET    | `/api/booking-triggers/history?limit=`        | what the workflow has done, newest first   |
| GET    | `/api/booking-triggers/bookings/:bookingId`   | one booking's whole ladder                 |
| POST   | `/api/booking-triggers/run`                   | climb what is due (`dryRun` for a preview) |
| POST   | `/api/booking-triggers/clear`                 | take rungs off the list without emailing   |
| POST   | `/api/booking-triggers/sweep`                 | run the scheduled pass now (admin)         |

Every one of them re-reads the bookings scoped to the signed-in user's club, so
a request cannot reach another club's guests, and the selection is re-made on
the server: the browser may have been looking at the list for an hour, and the
club's own rules decide what goes in an email, not the payload.

`scope=all` is bounded to bookings playing from 30 days ago onwards: the other
two scopes are narrow by construction, but the whole archive sorted oldest first
is both slow and useless, since the bookings somebody is looking for are at the
far end of it. A month back covers every round whose post-play rung is still
live. The window applies to the page only — a run plans `due` with no window, so
a rung inside the catch-up horizon is climbed whatever the page is showing, and
`/bookings/:bookingId` has no window either so a booking asked for by reference
is always found.

`dryRun` walks the same path as a real run — same selection, same rendered
email, same payment-link decision — and stops short of the send, so a preview
reports exactly what would happen.

## Things that are deliberate, and why

**The visitor dunning ladder is an extrapolation.** The specification writes the
chase cadence out in full for the tour operator flow and leaves the visitor
columns headed "If Paid / If not paid" with no text under them. Rather than
leave a visitor who never pays uncontacted for ever, the same ladder runs for
both, driven by the same settings. A club that wants the visitor flow to be the
payment link alone can move the deposit window out of reach under Settings or
clear the rungs it does not want on the page.

**The 30- and 10-day emails need money in, not all of it.** The specification
marks every communication trigger "If Paid". Taken literally, a booking with a
part-paid balance would get no arrival information at all, which is not what a
club wants on the Tuesday of the week somebody arrives. So
`pre_arrival_confirmation` and `final_details` require a payment rather than
full payment; `booking_confirmed`, which is the thank-you for settling, requires
the lot.

**Cancelling is cancelling, not deleting.** The specification says "booking
removed". The row stays, with its status set to `Cancelled` — see above.

**It polls rather than reacting.** Every rung of this ladder is dated to a
calendar day, and the thing that moves a booking between rungs is usually a
Stripe webhook this process does hear about but could not usefully act on
instantly anyway. A daily pass is the right cadence; `TRIGGER_SWEEP_MINUTES`
exists for a club that wants a same-day deposit request to go out within the
hour, and for the tests.
