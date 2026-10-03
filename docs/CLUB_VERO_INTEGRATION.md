# Connecting the dashboard to Club Vero

The post-play email already goes to every guest a couple of days after they
play, and it already asks them how it went. What it could not do is keep the
answer. A reply lands in an inbox; nothing counts it, scores it, or tells
anyone that the same complaint about the second tee has now arrived three
times.

Club Vero does all of that, and it is the same club's other product. So the
two are joined at the one moment they are both about — the send.

## What happens

1. Somebody picks a set of bookings on **Guest Emails** and presses send, or
   previews first.
2. For each booking, this dashboard hands the round to Club Vero: the booking
   reference, the play date, the course, and how to reach the guest.
3. Vero files it as a golf visit against the course, mints a survey for it, and
   hands back a link.
4. That link goes into the SendGrid template as `{{survey_url}}`, and the guest
   gets **one** email — from the club, in the club's own voice, with a feedback
   button that leads somewhere that can act on the answer.

The guest never sees Club Vero's name on an envelope, and never gets a second
email asking the same question.

## What you have to do once

### On the Club Vero side

1. Run `migrations/partner-bookings.sql`. Without it the handover is refused
   rather than half-working — see "Why it refuses" below.
2. Generate a key:

   ```
   node -e "console.log('sk_'+require('crypto').randomBytes(24).toString('hex'))"
   ```

3. Set `PARTNER_INGEST_KEYS=dornoch:<that key>` and restart.

### On this side

Set these and restart:

```
VERO_BASE_URL=https://clubvero.example.com
VERO_PARTNER_KEY=<the same key>
```

Then check the **Club Vero** tile on the Guest Emails page. "Linked" means the
next post-play run will carry survey links.

### In the SendGrid template

Add the button to the post-play template:

```html
<a href="{{survey_url}}">Tell us how it went</a>
```

and, in the footer, the unsubscribe the link comes with:

```html
<a href="{{unsubscribe_url}}">Unsubscribe from feedback requests</a>
```

Both fields are absent when the integration is off, so a template carrying them
still renders correctly either way — `{{survey_url}}` simply comes out empty.
Guard it with `{{#if survey_url}}` if you would rather the button disappeared
entirely.

## Things worth knowing before it runs

**A guest is never asked twice.** Vero keys the survey on the booking
reference, so a retry after a timeout, a re-run of the 30-day catch-up window,
or a deliberate resend all land on the *same* survey. A second one would strand
whatever the guest had already typed into the first. The resend gets the same
link back and the results table says so.

**Unsubscribes are honoured before the envelope is addressed.** A guest who has
used the unsubscribe link is reported as `Skipped`, counted apart from the
failures, and no email is sent. Somebody who unsubscribed as a *member* of the
club is also suppressed here — the booking system is not a way back in.

**A preview is a real preview.** A dry run asks Vero the same question in
preview mode. Vero writes nothing and answers with what it would do, so a guest
who has opted out shows up in the preview rather than being discovered halfway
through the live run.

## Why it refuses

With the integration on, **the post-play email is the feedback request** — the
link is the reason it exists. So when Vero cannot be reached, the send is held
rather than going out anyway:

> Club Vero timed out

The booking stays unstamped and the next run picks it up. That is deliberate.
Sending it anyway would spend the one message this guest is going to read on a
template with a dead button in it, and nobody is emailed twice about the same
round.

The other refusals name what to do:

| What it says | What it means |
| --- | --- |
| `Club Vero refused the round (401)` | The key or the partner name does not match `PARTNER_INGEST_KEYS` on the Vero side. |
| `Run migrations/partner-bookings.sql` | Vero cannot record where a visit came from, so a retry could send the same guest a second survey. Refused rather than risked. |
| `more than one club, so a round has to name one` | That Vero serves a group. Set `VERO_SITE` to the club's slug. |
| `Could not tell which outlet is the course` | Vero has no outlet carrying a golf survey template. Attach one on its Golf screen. |

## Where the code is

| | |
| --- | --- |
| `server/src/lib/vero-domain.js` | When a campaign carries a link, and what is sent about a round. Pure. |
| `server/src/lib/vero.js` | The call itself. |
| `server/src/routes/emails.js` | The send loop — Vero is asked first, because it can veto the send. |
| `server/test/vero-domain.test.js` | Both of the above. |

On the Club Vero side: `server/routes/partner-ingest.js`,
`server/lib/partner-ingest.js`, `migrations/partner-bookings.sql`.
