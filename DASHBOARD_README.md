# Royal Dornoch Visitor Bookings — JavaScript dashboard

A React single-page app served by an Express API, over the
`public.bookings` and `public.dashboard_users` tables the core API (the email
bot) writes to. It replaced the earlier Streamlit dashboard, which has been
removed from this repository.

```
server/   Express API (auth, bookings, analytics, exports, guest emails,
          tour operators and operator reminders)
web/      React + Vite SPA (bookings table, detail drawer, charts)
scripts/  seed + read-only compatibility check
```

## Running

```bash
npm install
cp .env.example .env         # DATABASE_URL + JWT_SECRET
npm run dev                  # API :3001, web :5173
npm run build && npm start   # production, single origin on :3001
```

| Script | Purpose |
|---|---|
| `npm run check` | Read-only preflight: can this database run the dashboard as-is? |
| `npm run seed` | Sample Royal Dornoch bookings (`--reset` to rebuild) |
| `npm test` | Unit tests for the booking and analytics arithmetic (no database needed) |

## Signing in

Accounts live in `public.dashboard_users`, and people sign in with their
**email address**.

The username is still accepted, and still exists on the row — it is what the
audit columns record, and it is the only way in for an account created before
this dashboard had an `email` column. Both are matched case-insensitively and
trimmed. So switching to addresses locks nobody out, but the login screen no
longer asks for a username: run `npm run check` to see which accounts still
have no address, and fill `dashboard_users.email` in for them.

A new account created from the Users page needs only a name, an address and a
role — the address becomes the username too, so there is nothing to invent.

### Creating accounts

The **Users** page (administrators only) adds, edits and removes logins. Run
its migration first — it needs the password-reset one below, so run them in
this order:

```bash
psql "$DATABASE_URL" -f migration_add_password_reset.sql
psql "$DATABASE_URL" -f migration_add_user_management.sql
```

That adds two roles, the audit columns behind an account, and marks an
outstanding link as an invitation rather than a reset. **Every account that
exists when the migration runs becomes an `admin`** — they could already do
everything, so this changes nothing on the day; new accounts default to
`staff` and are promoted deliberately. The backfill is guarded on "no admins
yet", so re-running the migration never promotes anybody a second time.

| Role | May do |
|---|---|
| `admin` | Everything, including managing accounts |
| `staff` | Everything except the Users page |

A new account is created **with no password at all**. It is emailed a one-time
link and the person sets their own, so a working credential never travels
through an inbox and an administrator never knows a colleague's password. The
link is the same object as a password reset, stored in the same table with
`purpose = 'invite'` and a longer life (`USER_INVITE_TTL_MINUTES`, 7 days by
default, against an hour for a reset). Set `SENDGRID_TEMPLATE_USER_INVITE` for
the invitation wording; without it an account can still be created, and the
page says what is missing rather than failing silently.

Three things the Users page will not let anybody do, because the undo for each
is a database console: remove their own administrator access, deactivate their
own account, or demote, deactivate or delete the last active administrator.
Deleting an account also kills any outstanding link it holds.

An account given a temporary password and `must_change_password` is forced
to set a permanent bcrypt-hashed one on first sign-in.

### Password reset

Self-service, emailing through the same SendGrid sender the guest campaigns
use. `migration_add_password_reset.sql` (above) adds `dashboard_users.email`
and a `password_resets` table, and fills the address in for accounts whose
username is already one. Then set
`SENDGRID_TEMPLATE_PASSWORD_RESET` and `APP_URL` (see `.env.example`). Until
both the migration and the configuration are in place the sign-in screen hides
the link rather than offering one that cannot send, and `/api/auth/reset-config`
says which half is missing.

The reset itself is deliberately dull to talk to:

- `POST /api/auth/forgot-password` answers with the same sentence whether the
  account exists, has no address on file, or was just emailed a link — so it
  cannot be used to find out who has an account here.
- The token is 32 random bytes and only its SHA-256 is stored, so a leaked
  database cannot be replayed into an account takeover.
- A link expires after `PASSWORD_RESET_TTL_MINUTES` (default 60), a new request
  supersedes any outstanding one, and redeeming a link burns every link that
  user has.
- Redeeming does **not** sign anybody in. The new password is proved at the
  sign-in screen, so the emailed link is never a way in by itself.
- Both unauthenticated endpoints are throttled, per account and per IP. That is
  a brake on a script, not a substitute for a rate limiter in front of the app.

The rules live in `server/src/lib/password-reset-domain.js` and are unit-tested
without a database or an API key.

## What it covers

Bookings list and filtering, the `Inquiry → Requested → Booked` pipeline
(the old `Confirmed` stage is retired: rows still carrying it read as
`Booked`, and `migration_retire_confirmed_status.sql` rewrites them), status/note/tee-time edits, delete, tee-time extraction from email
bodies, CSV and Excel export, Reports & Analytics, and the customer-journey
guest emails.

Beyond the original booking fields it also surfaces this install's later columns:
the hosted booking form's **guest details** (lead guest, phone, caddies,
special requests, submitted-at) and **accommodation** (nights, rooms, room
type, preferences, cost, resort fee). Columns are detected at runtime, so an
un-migrated database still loads.

It also covers the trade side of the book — tour
operator accounts, their credit terms, where the money sits, and the two
reminder campaigns that chase it. See **Tour Operators** below.

## Upload tee sheet

Bookings made in the club's own system, brought in so marketing and the
reports can see them.

```bash
psql "$DATABASE_URL" -f migration_add_booking_source.sql
```

Upload a CSV or Excel export. Column headers are matched against a list of
aliases, so `Confirmation Number`, `Pax`, `Green Fees` and `Playing Date` all
land where they should, and any header it could not place is reported rather
than silently dropped. Dates are read in ISO, slash, dotted and named-month
forms; times in 24-hour, 12-hour or Excel's fractional-day. Blank rows are
skipped, and a row whose date cannot be read is refused with its line number
instead of being guessed at.

It works in two steps on purpose. **Check the file** reads it and reports what
it found without writing anything; **Import** then writes. The failure worth
protecting against is silent: a sheet whose `03/04` means 4 March imports
perfectly and is wrong in every row, so the preview shows the dates it read and
which reading it used. Day-first is the default and can be switched.

Re-uploading the same file is safe. A row is a duplicate if its reference is
already here, or if the same guest already has a booking at the same time on
the same day — including a row a file repeats within itself. An upload can also
be undone as a batch, which removes only the rows nobody has edited since.

### Imported bookings and the reports

Everything uploaded is marked `source = 'imported'`, and that distinction runs
through the analytics:

| Counts imported bookings | Does not |
|---|---|
| Revenue, players, party size, course mix, busiest days, lodging, payments | Conversion funnel, conversion and loss rates, booking request utilisation, time to answer |

The rule is that an uploaded booking is **real play but was never an enquiry**.
Counting it in the funnel would credit TeeMail with converting something it
never saw; leaving it out of revenue would understate what the course actually
took. The KPI row reports `enquiries` and `imported` separately so the split is
visible rather than implied.

## Inbox

Emails the bot should not answer by itself: questions, complaints, tour
operators, enquiries with no dates, and anything Claude flags as needing a
person. The core API triages every inbound email and routes it (see
`ROYAL_DORNOCH_DEMO.md` in the core API repo); the ones held for a person land
here, and the guest is told a person will reply.

Each email shows what Claude understood it to be, why it was held, the whole
conversation so far, and a **drafted reply** written only from the club's own
information. Edit it, press **Send reply** (it goes from `FROM_EMAIL`, quoting
the guest's email, with the booking reference in the subject so their next
reply threads back), or **Dismiss** it. An email not yet tied to a booking can
be attached to one by its reference. The sidebar shows how many are waiting.

Changes and cancellations that quote a booking reference skip the Inbox: they
become **Guest Requests**, marked *read from an email*, and are approved or
declined there as usual.

**The guest's email on every booking.** The drawer opens with the **Original
email** — the first thing the guest sent, in full — and a **Reply** button
that answers it directly: the reply quotes their email and carries the booking
reference in the subject, so their answer threads back onto the booking.
Replying to an ordinary tee-time request does not put it in the Inbox.

Below it is the rest of the conversation — the bot's availability reply, the
payment link, the receipt, the journey emails, staff replies, and anything
else the guest wrote (each with its own **Reply**) — and **Email the guest**
for a fresh email. Bookings from before the email log was switched on, from
the booking form or from an uploaded tee sheet have no original email; the
drawer says so.

Needs `migration_add_email_inbox.sql`. Without it the Inbox page says so and
the core API answers everything automatically, as before.

## Guest requests

A guest follows a link in their confirmation email, sees their booking, and
asks to change or cancel it.

```bash
psql "$DATABASE_URL" -f migration_add_change_requests.sql
```

**The club decides, not the software.** By default nothing moves until somebody
approves it, because a tee time is scarce and usually inside a charging window.
Set `BOOKING_SELF_CANCEL_DAYS=7` and a guest cancelling a week or more out
takes effect immediately, while anything closer still waits. Amendments *never*
apply themselves — "could we move to Sunday" is a question about availability,
not a state change — so approving one marks the request answered and leaves the
booking to be edited where the tee sheet is.

Whichever applies is said to the guest in words **before** they press anything.
Nobody should be surprised by what a button did to their tee time.

**The link is stateless**: the booking reference plus an HMAC of it, signed with
`BOOKING_LINK_SECRET` (or `JWT_SECRET`). Nothing is stored, so there is no token
table to leak — the trade is that a single link cannot be revoked on its own,
only all of them at once by rotating the secret. It reaches exactly one booking
and never signs anybody in.

The guest page returns only what the holder of the link already knows — date,
time, players, course, total — and never the note, the phone number or the
payment state, because it answers to whoever the email was forwarded to. Every
bad link gets the same reply, so the URL cannot be used to discover which
booking references exist. One open request at a time per booking, and both
unauthenticated endpoints are throttled.

## Waitlist

Parties waiting for a time the club could not give them, and — the point of the
page — what became of them.

```bash
psql "$DATABASE_URL" -f migration_add_waitlist_conversion.sql
```

The table itself predates this dashboard, but nothing recorded *which booking*
an entry became: the Streamlit conversion wrote "Converted from waitlist:
WL-0001" into the booking's note and left it there. That cannot be reported on
without parsing prose, and it carries no timestamp. The migration adds
`converted_booking_id` and `converted_at`, and recovers the history already
sitting in those notes — so conversions made before today still count.

Converting from the dashboard writes the booking and the link in **one
transaction**. A booking without its link is a conversion the report cannot
see; a link without its booking is a conversion that never happened. Either
half alone is worse than neither.

Two rules keep the numbers honest:

- **Conversion is measured against entries that reached an ending** — converted
  plus cancelled. An entry still waiting has not failed to convert, it has not
  answered yet, and counting it as a failure makes a healthy list look broken.
  The rate against *every* entry is shown beside it, because a part-worked list
  flatters the first number.
- A conversion whose booking was later cancelled **still converted** — the
  waitlist did its job — but its value is not counted as revenue, the same rule
  the rest of the reports follow. Where a recovered conversion's booking cannot
  be found at all, it is counted and flagged, so the revenue figure is a floor
  rather than a total.

`Converted` is not a status anybody can type. Setting it has to create the
booking it converted to, so the API refuses it on the ordinary status edit and
directs the caller at the convert action. A converted entry cannot be deleted
either: it is the only record of that conversion.

### Conversions made somewhere else

A time found over the phone becomes a booking with nothing tying it back to the
list, so the rate under-reports by exactly that much. **Possible conversions**
finds them: people on the list who already have a booking at this club, on or
within three days of the date they asked for, made after they joined the list.

They are proposed, never applied — two people can share an inbox, and a guest
can wait for one date while booking another under their own steam. Each row
says *why* it matched and flags a differing party size, which is the usual
reason a match is wrong. Confirming one attaches the existing booking; it
creates nothing.

Cancelled bookings, bookings that predate the entry, and bookings already
recorded as another entry's conversion are never offered — one booking cannot
be two conversions without counting the same play twice in both the rate and
the revenue.

## Guest Emails

The two customer-journey campaigns,
sent from the dashboard rather than a cron job:

| Campaign | When | Template |
|---|---|---|
| Pre-arrival welcome | `PRE_ARRIVAL_DAYS` (default 3) before the play date | `SENDGRID_TEMPLATE_PRE_ARRIVAL` |
| Post-play thank you | `POST_PLAY_DAYS` (default 2) after the play date | `SENDGRID_TEMPLATE_POST_PLAY` |

Only `Booked` bookings are ever listed, and the welcome only lists bookings
whose **pre-play clock** has started — that is, money has been received, by a
Stripe payment or by staff marking the payment Paid or Deposit paid. The
welcome falls due `PRE_ARRIVAL_DAYS` before play and stays due until it is
sent, so a guest who pays the day before still gets one. The page says how many
booked guests are missing only because they have not paid. A club that
invoices after play can set `PRE_ARRIVAL_REQUIRES_PAYMENT=false` to list every
Booked booking again. The page opens on the guests due now and can widen to all upcoming play (welcomes) or the last 30
days (thank yous). Rows are ticked, previewed with a dry run that renders the
same template data without contacting SendGrid, then sent; a guest who has
already been written to stays listed with the timestamp, unticked, so a resend
has to be asked for.

Sending needs five environment variables — `SENDGRID_API_KEY`, `FROM_EMAIL`,
`FROM_NAME` and the two template IDs (see `.env.example`). Without them the
page still lists who is due and names what is missing, but cannot send.

De-duplication needs the tracking columns:

```bash
psql "$DATABASE_URL" -f migration_add_journey_emails.sql
```

Without them the emails still go out, and the page warns that a guest could be
written to twice.

The dynamic-template field names — `guest_name`, `booking_date`, `course_name`,
`tee_time`, `player_count`, `booking_reference` and the older `play_date` /
`booking_ref` spellings — match the earlier dashboard's exactly, so the
existing SendGrid templates work unchanged.


## Tour Operators

The trade half of the book: who books on behalf of guests, what credit they
trade on, what they owe, and what is chased when.

```bash
psql "$DATABASE_URL" -f migration_add_tour_operators.sql
```

Until that runs the two new pages say so and refuse politely; everything else —
bookings, analytics, guest emails — is unaffected. `npm run check` reports
whether an install has it.

**No restart is needed.** The schema lookup caches a complete schema for the
life of the process, but re-checks an incomplete one every 30 seconds, so a
migration run against a live database is picked up on its own. If the page
still reports the table missing a minute later, the dashboard is connected to a
different database than the migration was run against — check `DATABASE_URL`
against the project the SQL editor was pointed at.

### Identifying an operator

A booking is attached to an account on one of three kinds of evidence, and they
are deliberately not equal:

| Evidence | What it is | Acted on automatically |
|---|---|---|
| `assigned` | Somebody set `tour_operator_id` on the booking | Yes |
| `domain` | It arrived from a domain registered to the account | Yes |
| `name` | The account's name appears in the guest name or the enquiry text | **No** |

A name in prose is a suggestion, not an account. Those bookings stay with the
direct pile and are listed under **Unrecognised → Bookings that name an
operator** for somebody to confirm one at a time. Nothing is invoiced on the
strength of a phrase in an email body.

The same tab answers the harder question — *which operators do we trade with
that we have never set up?* — from the data rather than from memory. It groups
the unrecognised bookings by sending domain, drops the consumer mailboxes (a
family booking twice from Gmail is not a tour operator), and lists every
business domain seen more than once with its volume and value. "Open account"
carries the domain and a proposed name straight into the form.

### Credit terms

Each account carries five numbers, and the due date on every one of its
bookings is derived from them rather than stored:

| Term | Meaning |
|---|---|
| Payment terms (days) | Net days from the invoice date; 0 is payable on invoice |
| Deposit (%) | Share of the total due up front; 0 means no deposit |
| Deposit due (days before play) | Overrides the invoice terms for the deposit |
| Balance due (days before play) | Overrides the invoice terms for the balance |
| Credit limit | Most the account may owe at once; blank means none is enforced |

A "days before play" rule wins where it is set, because that is what a tour
operator contract actually says. With no such rule the invoice terms apply —
counted from the invoice date, or from the play date while nothing has been
invoiced, so a club that bills on departure still has a date to chase against.
A single booking can override either date, for the one that was agreed
differently.

Three consequences worth knowing:

- **The money decides the milestone, not the stored status.** A booking sits at
  its deposit until what has been paid covers the deposit, then at its balance.
  So a balance date inside the reminder window does not pull in a booking whose
  deposit is still outstanding — the deposit date does, and it is usually
  older.
- **Overdue is never stored.** It is derived from the due date against today on
  every read, because a stored "Overdue" is wrong the morning after it is
  written.
- **Exposure counts committed bookings only**, on the same rule the analytics
  page uses for revenue. An open enquiry is not money an operator owes, and
  counting it would put accounts over their credit limit on the strength of
  business the club has not agreed to.

The dashboard also reports when the recorded money and the typed payment status
disagree — a booking marked `Unpaid` that is fully paid up — as a hint beside
the figures. It never rewrites the status: the club's own record of what was
agreed is not the dashboard's to overwrite.

Deleting an account with bookings against it **retires** it instead. The
history and the debt stay where they are; only an account with nothing on it is
actually removed.

### Operator reminders

Two campaigns, one email per **account** rather than per booking — an operator
with eleven open bookings wants one message listing eleven lines, which is how
a trade partner reads their post.

| Campaign | Who is listed | Window |
|---|---|---|
| Booking status | Their bookings that have not reached `Booked` | `OPERATOR_STATUS_REMINDER_DAYS` (21) of play dates ahead |
| Payment due | Their committed bookings with money outstanding | `OPERATOR_PAYMENT_REMINDER_DAYS` (7) of due dates ahead, plus everything already late |

Sending is always explicit: accounts are ticked, previewed with a dry run that
renders exactly the data a real run would send, then sent. An account with
bookings but no contact email is still listed — marked unsendable, because that
is a gap somebody needs to fix rather than a silence.

Every booking that went into an email is stamped. The guard is per booking and
lasts seven days, which is the useful shape: an account chased last week about
four bookings is not chased again tomorrow, but a fifth booking that has just
fallen due pulls the account back into the list on its own. "Include recently
chased" widens the list and flags which lines have already been written about.

Sending needs `SENDGRID_API_KEY`, `FROM_EMAIL` and the two template IDs (see
`.env.example`). The sender credentials are shared with the guest campaigns on
purpose: a club that has configured SendGrid once should not have to do it
again to chase an invoice.

The template data carries the account (`operator_name`, `contact_name`,
`credit_terms`, `credit_limit`, `credit_headroom`), the totals
(`total_outstanding`, `total_overdue`, `days_overdue`, `earliest_due_date`) and
the line items twice — as `bookings`, the array a handlebars `{{#each}}` walks
to build a table, and as `booking_lines`, the same content preformatted for a
plain-text part.

### Payment on a booking

The booking drawer gains a **Trade account & payment** panel: which account the
booking sits on, what is owed and when, and fields for the payment status,
amount paid, invoice number and invoice date. Clearing an override date hands
that date back to the account's terms rather than leaving it blank.

The exports carry the same columns — operator, payment status, amount paid,
outstanding, due date, days overdue and invoice number — flattened onto the row,
because that spreadsheet is what goes to the bookkeeper.

### Card payment links (Stripe)

The payment panel can email the guest a Stripe payment link. Enter the amount
(it starts at whatever is still owed) and press **Email payment link**:

1. The dashboard creates a single-use Stripe Payment Link for that amount,
   carrying the booking id and club as metadata.
2. SendGrid emails it to the guest — from `SENDGRID_TEMPLATE_PAYMENT_LINK` if
   set, otherwise a plain built-in email.
3. The booking's payment status becomes **Pending**.
4. When the guest pays, Stripe calls `POST /api/stripe/webhook`. The payment
   is added to *amount paid* and the status becomes **Paid**, or
   **Deposit paid** if it covers only part of the total.

Only Stripe marks a booking paid; the dashboard never assumes it. Resending
switches the previous link off, so a guest cannot pay both. A Payment Link is
used rather than a Checkout Session because a session expires within a day and
an emailed link may not be opened for a week.

The webhook checks Stripe's signature against `STRIPE_WEBHOOK_SECRET` and
refuses anything unsigned, altered or more than five minutes old. Stripe
retries a webhook until it is acknowledged, so each payment is recorded once
however many times it is delivered. A bank-debit payment completes unpaid and
is only counted when `checkout.session.async_payment_succeeded` arrives.

**When the payment lands** the webhook, in one step:

- marks the payment **Paid** (or **Deposit paid**) and moves an Inquiry or
  Requested booking to **Booked** — a rejected or cancelled booking is left for
  a person to deal with, never revived;
- starts the booking's **pre-play clock**;
- emails the guest a **receipt**: amount, date, Stripe reference, booking
  details, and any balance still owed. `SENDGRID_TEMPLATE_PAYMENT_RECEIPT` is
  used if set, otherwise a built-in receipt.

A receipt that fails to send never undoes the payment. The drawer shows
*receipt not sent* with a **Send receipt** button, and **Resend receipt** once
one has gone.

**Payments are fetched, not only waited for.** The webhook is the fast path,
but if a delivery does not arrive or is refused (no endpoint in the right
Stripe mode, a wrong signing secret, a deploy at the moment Stripe calls), the
payment would otherwise be missed. So the dashboard also asks Stripe itself
for every booking whose link is out and unpaid: 15 seconds after start-up,
every `PAYMENT_SYNC_MINUTES` (default 2), and whenever the bookings list
loads. A payment is recorded the same way whichever route sees it first, and
only once.

**Check payment setup** in the drawer tests every link in the chain for real —
the key and its mode, the migrations, the signing secret, `APP_URL`, whether
Stripe actually has an enabled webhook endpoint at
`<APP_URL>/api/stripe/webhook` for the right events (it asks Stripe), the last
webhook received, and the last fetch from Stripe — and says what to change.

**If a payment does not show up.** Opening a booking that is awaiting payment
asks Stripe directly whether its link has been paid, and records the payment
(and sends the receipt) if so; **Check Stripe for payment** does the same on
demand. So a payment is never lost to a webhook that did not arrive. Under
that, the drawer shows the last webhook delivery and what happened to it — or
that none has arrived since the server started. The usual causes:

- no endpoint in Stripe for `https://<dashboard>/api/stripe/webhook`;
- the endpoint made in the other mode — test and live each have their own
  endpoints and their own signing secret;
- `STRIPE_WEBHOOK_SECRET` set to a different endpoint's secret (the drawer
  says *Signature mismatch*).

Opening `https://<dashboard>/api/stripe/webhook` in a browser confirms the URL
and whether the secret is set. Anything that stops a payment being recorded —
the secret or a migration missing, the database unreachable — is answered 5xx,
so Stripe keeps retrying for up to three days until it can be.

Setup: run `migration_add_stripe_payment_links.sql` and then
`migration_add_payment_receipts.sql`, set `STRIPE_SECRET_KEY`
and `STRIPE_WEBHOOK_SECRET` (see `.env.example`), and in Stripe → Developers →
Webhooks add `https://<dashboard>/api/stripe/webhook` for the two events above.
Until all of that is in place the drawer says what is missing instead of
offering the button.

## Branding

`web/src/lib/brand.js` plus the token block at the top of `web/src/theme.css`
carry everything club-specific in the JavaScript app.

The dashboard is branded **TeeMail Golf Club** by default. Every name is
configurable rather than hard-coded, because one deployment serves whichever
club it is pointed at: `CLUB_NAME` / `CLUB_FULL_NAME` on the server (the sender
name and wording on outgoing email), and `VITE_CLUB_NAME` / `VITE_CLUB_FULL_NAME`
/ `VITE_CLUB_TAGLINE` / `VITE_CLUB_LOGO` in the browser build. See
`.env.example`.

`customer_id` on a booking or an account is **data, not branding** — it is
never renamed to follow a rebrand. Rows carrying the old `royal_dornoch` id
display under the current brand name automatically, so nothing needs migrating.

**The logo** is `web/public/logo.png`, served at `/logo.png` — currently the
TeeMail mark, cropped to its artwork at 841×189 so it fills the 168px it is
drawn at rather than floating in a square of empty canvas.

To change it, drop new artwork in and crop it to the mark. It renders 168px
wide, so supply roughly 350px or more for a retina screen. The mark is dark on
transparent, so it is given a light plate to read against the dark sidebar —
without one its wordmark sits at 1.26:1 against `--surface-0` and effectively
disappears; on the plate it is 11.49:1. Set `VITE_CLUB_LOGO_ON_DARK=true` only
for artwork that already reads on a dark background. Set `VITE_CLUB_LOGO=`
empty to drop the image entirely and render the styled wordmark instead, which
needs no artwork at all.

Two names are deliberately **not** branding and were left alone:
`VERO_PARTNER_SOURCE` defaults to `dornoch` because it must match the key
registered on the Club Vero side (`PARTNER_INGEST_KEYS=dornoch:…`), and
changing it here without changing it there breaks the survey integration.
Surfaces are green, accent gold, text sand. The palette is still the one
validated against the `#1D3B2A` chart surface — see **Chart colours** below
before changing any of it.

### Reports & Analytics

The analytics endpoint aggregates in `server/src/lib/analytics-domain.js` — pure
functions over serialised bookings, so every number here is unit-tested without
a database (`npm test`).

| Section | Question it answers |
|---|---|
| KPI row | Bookings, committed revenue, average value, conversion and loss rate, each against the preceding period of equal length |
| Over time | Bookings, revenue or players by tee date, at daily / weekly / monthly granularity |
| Conversion funnel | How many reached each stage, and how many were lost *at* each stage |
| Lead time | How far ahead the sheet fills, bucketed, with the median |
| Party size | Where the volume and the money sit, by players per booking |
| Course mix | Championship vs Struie vs unrecorded |
| Booking request utilisation | Weekday against time-of-day band, counting what enquiries **asked for** beside what was actually **booked**: requested, converted, lost, still open, conversion rate, and the parties whose tee sheet slot is not the one they asked for |
| Asked for, not booked | The slots with the most demand that never became a booking |
| Moved to another slot | Where the sheet put parties that asked for a different band |
| Collection | Value, paid, outstanding and overdue on committed bookings, by payment status |
| Overdue by age | How old the outstanding money is, on the same ageing bands as the operator statements |
| Direct against trade | Volume, party size, conversion and average value either side of the operator split, and the accounts carrying the book |
| Accommodation | Attach rate and basket size, length of stay, room types, room nights, and committed revenue split into golf, lodging and resort fees |
| Caddie demand | How many parties ask, how many say no, and an estimate of the caddies needed |
| What people write in | The themes the free-text fields mention, by keyword |
| Journey email coverage | Which committed bookings the pre-arrival and post-play emails actually reached |
| Repeat and new guests | Distinct addresses, who booked more than once, and business against personal domains |
| Time to answer | How long an enquiry waits between landing and being confirmed |

Every section built on a later migration carries its own "is there anything
here" flag, so an install that does not use tour operator accounts, does not
record lodging detail or has not run the journey-email migration is told which
one rather than shown a grid of zeroes.

Three things the numbers deliberately do **not** do. Revenue counts only
`Booked`, so an open enquiry never inflates it. Course mix
counts a booking naming both courses toward each, so those rows do not sum to
the total — the card says so on its face. And on the request grid, a slot's
"asked for" count and its "on the sheet" count are separate tallies rather than
two views of one number: an enquiry is counted on the slot it *requested*
(`selected_tee_times` where the form recorded it, otherwise `tee_time`),
whatever became of it, while a booking is counted on the slot the sheet
actually carries. A party that asked for 08:00 and plays 14:30 therefore
appears in both, which is what makes "demand we did not satisfy here" legible
at all — a grid of confirmed bookings alone cannot tell a slot nobody wants
from a slot everybody walks away from. Rows with no usable date or time are
left off the grid and reported as a count beside it.

Two further readings are honest about their own limits. "Returning guest" means
more than one booking *inside the selected period* — this endpoint never sees
the rest of the book, so it cannot claim a lifetime number. And the request
themes are keyword matches over free text, so a booking counts toward every
theme it mentions and one nobody has a word for lands in none: a reading aid
for the notes, not a classification of them.

The comparison window is the same length immediately before the selected range,
so "next 90 days" is judged against the 90 days before it. Where the previous
period was zero, the tile says "No activity in the previous period" rather than
showing an infinite percentage.

### Charts

The chart components in `web/src/components/charts/` are Tremor's
(<https://www.tremor.so/charts>) ported to plain JSX and re-themed onto the
club's palette, rather than the `@tremor/react` package — which has not been
published since January 2025 and pulls in four sizeable transitive
dependencies. They are Recharts underneath, which the dashboard already used.

Tremor needs Tailwind, so Tailwind is in the build with **`preflight`
disabled**: this app is styled by `theme.css`, and Tailwind's base reset would
flatten its buttons, inputs and tables. Utilities are emitted after that
stylesheet so a chart can still override locally. `web/tailwind.config.js`
reads its colours from `web/src/lib/palette.js`, so the theme and the validated
ramps cannot drift apart.

### Chart colours

`web/src/lib/palette.js` is the single source, and every ramp in it was checked
against this app's own chart surface (`#1D3B2A`) rather than a generic dark
grey. Re-run the validator before changing any value.

| Ramp | Job | Result on `#1D3B2A` |
|---|---|---|
| Pipeline `#B8862B → #F0E0A6` | ordinal (funnel, status) | monotone lightness, step gaps, light end 3.79:1 |
| Sequential `#4a4c28 → #dec163` | heatmap magnitude | one hue (21° spread), monotone |
| Categorical `#3987e5, #d95926, #199e70` | identity (courses) | all-pairs CVD ΔE 9.4, normal-vision ΔE 20.9 |
| Delta `#2FB24A` / `#E8636B` | period-over-period | both clear 3:1 |

The payment states are not a new ramp. They reuse the pipeline ramp for the one
thing it was validated for — progress toward a finished state — with muted ink
for nothing paid, the mid gold for a deposit and the light end for settled, plus
the reserved slate for refunded and written off. `Overdue` is not one of them:
it is derived, so it never appears alone, only beside the written day count
(`4d late`), which is what carries the meaning.

Three consequences worth knowing before editing:

- **The categorical array is capped at three.** A fourth hue does not clear the
  all-pairs floors on this surface, so a fourth category folds into "Other" or
  the chart becomes a table.
- **Up-green and down-red are the same colour to a deuteranope** (ΔE 2.4). The
  delta cues therefore only ever appear in a stat tile beside an arrow glyph and
  the signed number, never as a mark inside a plot.
- **An empty heatmap cell is bare surface with a hairline**, not the ramp's
  darkest step, so "nobody booked this" and "almost nobody booked this" cannot
  look alike.

The club's own status colours still could not be carried over, for the reasons
below. Every status is written out in text as well, and every chart has a table
view behind "Show the numbers", so no reading depends on colour.

The original categorical status colours are unusable here: North Sea blue for
Requested reaches only 1.74:1 on this surface, and the two greens for Confirmed
and Booked sit ΔE 8.8 apart — below the 15 floor. The terminal states use
reserved colours outside the brand palette: `Rejected #DB4F7D` and
`Cancelled #93A9B8`.

### Logo

The logo is `web/public/logo.png` (the TeeMail mark). It is dark artwork, so
the sidebar shows it on a light plate. If a reversed (light) logo is supplied,
replace the file and set `BRAND.logoOnDark = true`. Emails use the same file —
see **Email branding** in `.env.example`.

## Deploying

A Render web service, against the same database as the core API:

| Setting | Value |
|---|---|
| Build Command | `npm install --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

`--include=dev` is required: Render sets `NODE_ENV=production`, which makes npm
skip devDependencies, and `vite` is one of them.

Set `DATABASE_URL` and a fresh `JWT_SECRET`, plus the SendGrid variables above
if the Guest Emails page should be able to send. `SEED_ON_START=true` seeds sample
data at boot for hosts without shell access; it skips when real bookings exist.
