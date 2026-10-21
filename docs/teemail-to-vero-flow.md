# TeeMail → Club Vero: one guest, one round, one email

The end-to-end path for a **single-site club**: a guest's enquiry arriving as an
email, through TeeMail's booking pipeline and the round itself, into Club Vero's
post-play survey and the case work that follows.

Three codebases, joined at exactly one point — the post-play send. TeeMail's
core API and dashboard share a Postgres database; Vero shares nothing with
either, and is reached by one authenticated HTTPS call per round.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  PART 1 — TEEMAIL: an email becomes a booking      (Demo_core_api, Flask)    ║
╚══════════════════════════════════════════════════════════════════════════════╝

   GUEST
     │  "4 of us, mid-June, can we get on twice?"  → bookings@club.teemail.io
     ▼
   SendGrid Inbound Parse  (club inbox MX)
     │  POST /webhook/inbound?key=…        (multipart)
     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │ shared webhook key · queue slot · To: tag filter                       │
 │ duplicate check (Message-ID / content hash, 5-min cache)               │
 │ INSERT email_messages (queued, full body, SPF/DKIM results)            │
 │ ──► 200 {"status":"accepted"}   ← recorded BEFORE SendGrid is answered  │
 └───────────────────────────────┬────────────────────────────────────────┘
                                 ▼  background thread pool (per gunicorn worker)
 ┌────────────────────────────────────────────────────────────────────────┐
 │ claim the row (queued → processing) — a recovery thread re-runs any    │
 │ a worker didn't finish                                                 │
 │ SPF/DKIM alignment · per-sender rate limit · quoted-reference lookup   │
 └───────────────────────────────┬────────────────────────────────────────┘
                                 ▼
            TRIAGE — one Anthropic call per email, regex/keyword fallback
            (club facts cached in the system prompt; booking-on-file facts added)
                                 │
   ┌──────────────┬──────────────┼────────────────┬─────────────────────┐
   ▼              ▼              ▼                ▼                     ▼
 ignored    unverified /     change or       held for staff        AUTOMATIC
 routed_to  rate-limited     cancellation    routed_to=inbox       REPLY
 =ignored   → Inbox,         by the          + draft reply             │
            no reply         booking's       + holding email           │
                             guest               │                    │
                                 │               └─ staff answer from  │
                      INSERT booking_change_        the Inbox screen   │
                      requests (Pending)                               │
                      + "request received"                             │
                                                                       ▼
                                   ┌───────────────────────────────────────────┐
                                   │ parse details (dates, players, rounds,    │
                                   │ lodging, company, handicaps)              │
                                   │ availability: demo tee sheet │ tee_times  │
                                   │               table │ rGuest              │
                                   │ INSERT bookings (Inquiry) +               │
                                   │        offered_tee_times                  │
                                   │ reply: branded HTML + signed Book Now     │
                                   │        links (BOOKING_LINK_SECRET)        │
                                   └──────────────────┬────────────────────────┘
                                                      ▼
   GUEST clicks ──► GET /book?booking_id&token…   (HMAC verified, 403 if not)
     │             server-computed quote · POST /api/quote (no side effects)
     ▼
   POST /submit-booking   rate limit · token · rounds must be among those offered
     │                    re-priced server-side
     ▼  UPDATE bookings … WHERE status IN (Inquiry,Pending,Requested) → Requested
   acknowledgement email + signed manage-booking link  ──► dashboard /manage-booking

╔══════════════════════════════════════════════════════════════════════════════╗
║  PART 2 — TEEMAIL DASHBOARD: commit, pay, play       (Demo_Dashboard, Node)  ║
╚══════════════════════════════════════════════════════════════════════════════╝

   STAFF on the Bookings board
     │   pipeline:  Inquiry ──► Requested ──► Booked      (Rejected / Cancelled)
     │              (legacy 'Confirmed' folds into Booked)
     ▼
   PAYMENT — Stripe, or staff recording it
     │   payment_status → Paid / Deposit paid
     │   stamps the PRE-PLAY CLOCK (pre_play_clock_started_at)
     ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ CAMPAIGN 1 · pre_arrival — 3 days BEFORE play (PRE_ARRIVAL_DAYS)     │
   │   Booked + paid only. Carries NO survey link, deliberately: a        │
   │   feedback button here asks about a round nobody has played yet.     │
   └──────────────────────────────────────────────────────────────────────┘
     │
     ▼
 ╭──────────────────────────────────────────────────────────────────────────╮
 │                      ⛳  THE GUEST PLAYS THE ROUND  ⛳                   │
 ╰──────────────────────────────────────────────────────────────────────────╯
     │
     ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ CAMPAIGN 2 · post_play — 2 days AFTER play (POST_PLAY_DAYS)          │
   │   Guest Emails screen: pick bookings, Preview or Send                │
   │   eligible: status Booked · play date passed · not already stamped   │
   │             (post_play_email_sent_at) · showAll looks back 30 days   │
   └───────────────────────────────┬──────────────────────────────────────┘
                                   ▼
╔══════════════════════════════════════════════════════════════════════════════╗
║  PART 3 — THE HANDOVER            lib/vero-domain.js → lib/vero.js           ║
║                                                                              ║
║  Vero is asked FIRST, because it can veto the send.                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

   for each booking in the run (a dry run walks the identical path):
                                   │
     POST {VERO_BASE_URL}/api/partner/golf-round
     headers: X-Partner-Source: dornoch   X-Partner-Key: sk_…
     body:  external_ref  = booking reference   ← the whole of the idempotency
            play_date · tee_time · course_name
            guest_name · guest_email · guest_phone
            players · spend_amount (only when real)
            site (group deployments only) · dry_run
                                   │
     ══════════════════════════════╪═══════════════ repo boundary ═════════════
                                   ▼
   ┌──────────────────── CLUB VERO  server/routes/partner-ingest.js ─────────┐
   │ authenticate partner by name+key (401 names neither half)               │
   │ resolve site: slug, or the only active one, or PARTNER_DEFAULT_SITE     │
   │ resolve the COURSE outlet — the one carrying a golf survey template     │
   │ opt-out check: guest_opt_outs AND members.opt_out                       │
   │     └─ a read failure REFUSES rather than mails everybody               │
   │ already seen? (external_source, external_ref) unique index              │
   │     └─ yes → hand back the SAME survey link, answered?, answered_at     │
   │ no  → INSERT visits (guest golf round) + survey_responses(token)        │
   │       stamp visits.survey_sent_at  ← keeps Vero's own nightly golf      │
   │                                      send from asking a second time    │
   └──────────────────────────────┬─────────────────────────────────────────┘
                                  ▼
        ┌─────────────────────────┴──────────────────────────────────┐
        ▼                                                            ▼
   ANSWERED OK                                            REFUSED / HELD
   survey_url + unsubscribe_url                   • timeout → booking left
        │                                           UNSTAMPED, next run
        │                                           retries. Better no email
        │                                           than one with a dead button
        │                                         • 401 → key/source mismatch
        │                                         • 409 → run partner-bookings.sql
        │                                         • 400 → group, name a site
        │                                         • 409 → no golf outlet
        │                                         • suppressed → "Skipped",
        │                                           counted apart from failures,
        │                                           nothing sent
        ▼
   SendGrid dynamic template (SENDGRID_TEMPLATE_POST_PLAY)
     {{survey_url}} / {{feedback_url}}  →  "Tell us how it went"
     {{unsubscribe_url}}                →  footer
     absent when the integration is off, so the template still renders
        │
        ▼
   ONE email, from the club, in the club's own voice.
   The guest never sees Vero's name and never gets a second request.
        │
        ▼
   stamp bookings.post_play_email_sent_at

╔══════════════════════════════════════════════════════════════════════════════╗
║  PART 4 — CLUB VERO: what the answer sets off     (Vero_Multi_Site_Dev)      ║
║  Full detail: Vero's own docs/post-play-workflow.md                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

   GUEST taps the button ──► /s/:token ──► POST /api/survey-response/:token
     │   NPS · overall · pace of play · service · free-text comment
     │   (or /u/:token to unsubscribe — honoured on every later handover)
     ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ scores   ──► golf scores, outlet & club trends, leaderboards         │
   │ comment  ──► AI tags & themes · sentiment · praise inferred and      │
   │              credited to the named staff member                      │
   │ severity ──► none → scores only                                      │
   │              low / medium / high → CASE ALERT                        │
   │              (good scores + bad words raise one too, and say so)     │
   │              contact_due_at set NOW: 24h / 3d / 7d by severity       │
   └───────────────────────────────┬──────────────────────────────────────┘
                                   ▼
   routed to the course's owner_staff_id (+ cc list), emailed with the
   one-tap /c/:token buttons; managers are the fallback, not the default
                                   │
                                   ▼
   RECOVERY — a manager telephones the guest. Vero sends the guest NOTHING
   here: it times the call, records it, and reports on it.
     waiting → due → urgent → breached, nudged hourly by recovery-sweep
     reached / voicemail (attempt, not recovery) / wrong_number (no attempt)
                                   │
                                   ▼
   CLOSE — resolve asks for contact first (409 + reasons, it asks not blocks);
   root_cause · action_taken · goodwill → case_resolutions
                                   │
                                   ▼
   READ BACK — daily digest · nightly praise · Friday AI analysis
   (insight, root-cause headline, theme clusters, training plan) ·
   recovery stats: % contacted in window, median hours, % who scored
   higher next time
```

## Where the seams are

| Seam | Carried by | Shared |
|---|---|---|
| Core API ↔ Dashboard | the Postgres database | `bookings`, `email_messages`, `booking_change_requests`, `BOOKING_LINK_SECRET`. The dashboard owns the schema; its migrations deploy first. |
| Dashboard → Vero | one HTTPS call at send time | nothing but the payload above and `PARTNER_INGEST_KEYS`. No shared database, no shared schema, no shared deploy. |
| Vero → guest | the club's own email | only the link. Vero never addresses an envelope on a handed-over round. |

## Single-site notes

- **TeeMail** is one club per deployment: one club profile, one inbox, one
  `BOOKING_LINK_SECRET`.
- **Vero** needs no `site` in the payload when it serves one club — it resolves
  the only active one (or runs unscoped on a deployment predating
  `migrations/multi-site.sql`). `VERO_SITE` is for a group.
- The round arrives already stamped as sent, so it never enters Vero's nightly
  batch, its spend thresholds or its frequency caps. The club decided this
  guest gets a survey by sending the post-play email; Vero does not second-guess
  that — which is why `spend_amount` is sent only when it is a real figure.
