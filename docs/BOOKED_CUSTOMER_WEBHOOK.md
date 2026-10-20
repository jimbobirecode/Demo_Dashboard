# Posting booked customers to another system

A club's other systems mostly want one thing from this dashboard: who is
actually coming to play. Not the enquiries, not the ones still being
negotiated — the bookings that are on. Exporting a spreadsheet answers that
once; this answers it continuously.

When a booking reaches **Booked**, the customer and their round are POSTed as
JSON to an endpoint you nominate. One customer per request.

## What you have to do once

1. Stand up an endpoint that accepts `POST` with a JSON body and answers
   `2xx` once it has stored the booking.
2. Set two variables and restart:

   ```
   BOOKED_WEBHOOK_URL=https://crm.example.com/hooks/booked
   BOOKED_WEBHOOK_KEY=whk_...
   ```

   Both are required. Until both are set nothing about a booking leaves this
   dashboard, and the log says which half is missing.

The URL must be `https`. The body carries a guest's name, email address and
phone number, and `http` would put all three on the wire in clear — the
dashboard refuses to send at all and says so at boot. `http://localhost` is
allowed, so you can point it at a receiver on your own machine while you build
one.

The key travels in the `x-webhook-key` header, never in the body: a body is
data, and data ends up in logs beside the guest's email address. If your
receiver wants a bearer token instead, set
`BOOKED_WEBHOOK_AUTH_HEADER=Authorization` and make the key
`Bearer <your token>`.

## What arrives

```json
{
  "source": "dornoch",
  "event": "booking.booked",
  "sentAt": "2026-02-01T10:00:00.000Z",
  "club": "royal_dornoch",
  "bookingRef": "RD-1041",
  "status": "Booked",
  "bookedAt": "2026-02-01T09:15:00.000Z",
  "customer": {
    "name": "Ann McLeod",
    "email": "ann.mcleod@example.com",
    "phone": "+447700900000"
  },
  "round": {
    "date": "2026-03-18",
    "teeTime": "08:40",
    "players": 4,
    "course": "Championship",
    "caddies": {
      "requirement": "2 caddies",
      "status": "Requested",
      "estimatedCaddies": 2
    }
  }
}
```

`bookedAt` is when this dashboard saw the booking reach Booked; `sentAt` is
when this particular request was made. The two differ on a retry.

**What is deliberately not in it**: the total, what has been paid, the lodging
and its preferences, the guest's special requests, and the staff note. Those
are the club's commercial terms and the guest's own words. They are not needed
to identify a customer, a tee time or a caddie, and the cheapest way to keep
them out of somebody else's database is never to send them. If a receiver
genuinely needs them, widen `buildBookedCustomerPayload` in
`server/src/lib/booked-webhook-domain.js` deliberately rather than by accident
— and say so in the club's privacy notice.

### Caddies

Caddies are the one request on that list somebody has to actually turn up for,
so they are sent, three ways:

| Field | What it is |
| --- | --- |
| `requirement` | What was recorded, verbatim, or `null` if nobody answered. The authoritative value. |
| `status` | `Requested`, `Not required` or `Not specified` — this dashboard's own reading of the text. |
| `estimatedCaddies` | How many, where they were asked for; `null` otherwise. |

The enquiry form offers a fixed set of answers ("No caddies required",
"2 caddies", "4 caddies (one per player)", "Forecaddie" …), so `requirement` is
closer to an enum than to prose — but imported and older rows carry whatever
somebody typed, which is why `status` exists. It comes from the same function
the Analytics page uses, so one booking is never a request on one screen and a
refusal on another. It also knows the traps: `No. of caddies: 4` is a request,
not a refusal.

`estimatedCaddies` is an **estimate**, and the most common answer is why: "for
all players" carries no number, so it falls back to the party size. Trust
`requirement` and `status`; treat the number as the starting point for a caddie
master rather than a commitment. It is `null` wherever caddies were not asked
for — a number sitting beside "No caddies required" is too easily read as a
booking for that many.

## Delivery, and why you will occasionally see a duplicate

Your endpoint should key on `bookingRef` and treat a repeat as the same
customer.

The dashboard sends on the transition and stamps the booking only once your
endpoint has accepted it. A booking with no stamp is one you have not accepted,
so a sweep every couple of minutes finds it and tries again. That is what
covers:

- your receiver being down, or slow, or answering `503`;
- the four different things that move a booking to Booked — a user in the
  dashboard, a Stripe payment, a converted waitlist entry, a tee-sheet import;
- the core API, which marks bookings Booked in its own process, where no
  dashboard code runs at all.

The rule lives in the data rather than in each of those paths, so a new way to
book cannot quietly arrive without a handover. The cost is that a process
killed between the POST and the stamp sends that one booking twice — which is
the right way round to be wrong: a duplicate you can drop beats a customer
nobody ever hears about.

An outage (`429`, `5xx`, a timeout) stops that pass of the sweep rather than
timing out once per booking in the backlog, and is logged as a warning. A
refusal of one booking (`400`, `403`, `422`) is logged as an **error** and the
sweep carries on with the rest.

Neither is stamped, so both are tried again every pass. A refusal is not given
up on: most are a receiver's own bug or a validation rule it has yet to relax,
and the booking starts succeeding once that is fixed, with nothing to replay by
hand. The error in the log every couple of minutes is the alert that something
needs the fixing — if a booking is genuinely unsendable and the noise is not
wanted, stamp that one row (see the SQL below).

`BOOKED_WEBHOOK_MINUTES` (default 2) sets how often the sweep runs;
`BOOKED_WEBHOOK_BATCH` (default 25) how many it sends per pass.

## Bookings with nobody to reach

An imported tee-sheet row is often just a name and a time. A booking with no
email address **and** no phone number is not a customer a receiver can do
anything with, so it is skipped rather than posted as a near-empty record. It
is not an error and nothing retries it; add contact details later and the next
sweep picks it up.

## Switching it on for a club that already has bookings

Every existing Booked booking has no stamp, so it has not been handed over —
and the first sweep will start working through the lot, 25 at a time.

That is usually what you want. If it is not, and the club only wants bookings
from here on, stamp the back catalogue as already sent before you set the
variables:

```sql
UPDATE public.bookings
   SET booked_webhook_sent_at = NOW()
 WHERE club = 'royal_dornoch'
   AND status = 'Booked'
   AND booked_webhook_sent_at IS NULL;
```

To re-send one booking, clear its stamp and wait for the next sweep:

```sql
UPDATE public.bookings SET booked_webhook_sent_at = NULL WHERE booking_id = 'RD-1041';
```

## Where it lives

| File | What it holds |
| --- | --- |
| `server/src/lib/booked-webhook-domain.js` | The rules: is it configured, what is sent, which bookings qualify. Pure, so it is testable without a key or a receiver. |
| `server/src/lib/booked-webhook.js` | The POST. Resolves to an outcome rather than throwing, and says whether a failure is worth retrying. |
| `server/src/lib/booked-webhook-outbox.js` | The handover on a transition, the sweep that catches the rest, and the stamp. The only part that touches the database. |
| `db/migrations/0011_booked_customer_webhook.sql` | `bookings.booked_webhook_sent_at`, and the partial index the sweep reads. |
| `server/test/booked-webhook.test.js` | What is sent, what is not sent, and what happens when the receiver refuses or disappears. |
