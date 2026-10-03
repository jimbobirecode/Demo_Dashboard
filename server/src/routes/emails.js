/**
 * Customer-journey email campaigns: the pre-arrival welcome and the post-play
 * thank you, driven from the dashboard rather than a cron job.
 *
 * The browser only ever names a campaign and a set of booking references — the
 * rows themselves are re-read here, scoped to the signed-in user's club, so a
 * request cannot reach another club's guests.
 *
 * Where the Club Vero integration is configured, a campaign that carries a
 * survey link asks Vero for one per booking before the email goes out, and the
 * link arrives in the template data as {{survey_url}}. See lib/vero-domain.js
 * for when that applies and lib/vero.js for the call itself.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import { BOOKING_SELECT } from '../lib/schema.js';
import {
  CAMPAIGN_IDS,
  buildTemplateData,
  countAwaitingPayment,
  campaignReady,
  cleanEmail,
  getCampaign,
  publicEmailConfig,
  readEmailConfig,
  selectCandidates,
  targetDate,
  todayInClubZone,
  validateRecipient,
} from '../lib/email-domain.js';
import { sendTemplateEmail } from '../lib/sendgrid.js';
import { logEmail } from '../lib/email-log.js';
import {
  buildRoundPayload,
  publicVeroConfig,
  readVeroConfig,
  veroEnabledFor,
} from '../lib/vero-domain.js';
import { requestSurveyLink } from '../lib/vero.js';

const router = Router();
router.use(requireAuth);

/** A campaign run never sends more than this in one request. */
const MAX_BATCH = 200;

async function loadClubBookings(club) {
  const { rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE club = $1`, [club]);
  return rows.map(serialiseBooking);
}

/** Record the send, so the guest is not emailed twice. */
async function markSent(campaign, bookingId, club) {
  await query(
    `UPDATE public.bookings SET "${campaign.column}" = NOW()
      WHERE booking_id = $1 AND club = $2`,
    [bookingId, club],
  );
}

function resolveCampaign(req, res) {
  const id = req.query.campaign ?? req.body?.campaign;
  const campaign = getCampaign(id);
  if (!campaign) {
    res.status(400).json({ error: `Unknown campaign: ${id}. Expected one of ${CAMPAIGN_IDS.join(', ')}.` });
    return null;
  }
  return campaign;
}

/** What is configured for sending. */
router.get('/config', (req, res) => {
  res.json({
    ...publicEmailConfig(readEmailConfig()),
    vero: publicVeroConfig(readVeroConfig()),
  });
});

/** The bookings a campaign would send to, due today or across the wider window. */
router.get('/pending', async (req, res, next) => {
  const campaign = resolveCampaign(req, res);
  if (!campaign) return;

  const scope = req.query.scope === 'all' ? 'all' : 'due';

  try {
    const config = readEmailConfig();
    const { days } = config.campaigns[campaign.id];
    const today = todayInClubZone();
    const bookings = await loadClubBookings(req.user.customerId);
    const options = { campaign, days, today, scope, requirePayment: config.requirePayment };

    res.json({
      campaign: campaign.id,
      scope,
      days,
      today,
      targetDate: targetDate(campaign, days, today),
      startsOnPayment: Boolean(campaign.startsOnPayment && config.requirePayment),
      awaitingPayment: countAwaitingPayment(bookings, options),
      bookings: selectCandidates(bookings, options),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Send a campaign to the named bookings.
 *
 * `dryRun` walks the same path — same eligibility checks, same Club Vero
 * decision, same rendered template data — and stops short of the SendGrid
 * call, so a preview reports exactly what a real run would do. Vero is asked
 * in preview mode too: it answers with what it would do and writes nothing, so
 * a guest who has unsubscribed shows up in the preview rather than being
 * discovered halfway through the real run.
 */
router.post('/send', async (req, res, next) => {
  const campaign = resolveCampaign(req, res);
  if (!campaign) return;

  const { bookingIds, dryRun = false } = req.body ?? {};
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
    return res.status(400).json({ error: 'bookingIds must be a non-empty array' });
  }
  if (bookingIds.length > MAX_BATCH) {
    return res.status(400).json({ error: `Too many bookings in one run (max ${MAX_BATCH}).` });
  }

  const config = readEmailConfig();
  if (!dryRun && !campaignReady(config, campaign.id)) {
    return res.status(400).json({
      error: `Email is not configured. Missing: ${config.missing.join(', ')}.`,
    });
  }

  try {
    const bookings = await loadClubBookings(req.user.customerId);
    const byId = new Map(bookings.map((booking) => [booking.bookingId, booking]));

    const vero = readVeroConfig();
    const handOverToVero = veroEnabledFor(vero, campaign.id);

    const results = [];
    let sent = 0;
    let failed = 0;
    // Counted apart from failures on purpose. A guest who has unsubscribed is
    // not a fault to investigate — lumping them in with the bad addresses is
    // how a working opt-out gets "fixed".
    let skipped = 0;

    for (const bookingId of bookingIds) {
      const booking = byId.get(bookingId);
      if (!booking) {
        failed += 1;
        results.push({ bookingId, email: null, status: 'failed', message: 'Booking not found' });
        continue;
      }

      const problem = validateRecipient(booking);
      if (problem) {
        failed += 1;
        results.push({ bookingId, email: booking.guestEmail || null, status: 'failed', message: problem });
        continue;
      }

      const email = cleanEmail(booking.guestEmail);

      // Club Vero first, because it can veto the send.
      let survey = null;
      let veroNote = null;

      if (handOverToVero) {
        const handover = await requestSurveyLink({
          baseUrl: vero.baseUrl,
          apiKey: vero.apiKey,
          source: vero.source,
          round: buildRoundPayload(booking, { site: vero.site, dryRun }),
        });

        if (!handover.ok) {
          // No link, no email — and this is the deliberate part. With the
          // integration on, the post-play email IS the feedback request: its
          // whole purpose is to carry that link. Sending it anyway would spend
          // the one message this guest is going to read on a template with a
          // dead button in it, and a guest is not emailed twice about the same
          // round. Failing here instead leaves the booking unstamped, so the
          // next run picks it up once Vero is answering again.
          failed += 1;
          results.push({ bookingId, email, status: 'failed', message: handover.message });
          continue;
        }

        if (handover.suppressed) {
          skipped += 1;
          results.push({ bookingId, email, status: 'skipped', message: handover.message });
          continue;
        }

        survey = { surveyUrl: handover.surveyUrl, unsubscribeUrl: handover.unsubscribeUrl };
        veroNote = handover.message;
      }

      if (dryRun) {
        const resend = booking[campaign.field]
          ? 'Dry run — already sent once, this would be a resend'
          : 'Dry run — not sent';
        results.push({
          bookingId,
          email,
          status: 'would_send',
          message: veroNote ? `${resend}. ${veroNote}` : resend,
        });
        continue;
      }

      const outcome = await sendTemplateEmail({
        apiKey: config.apiKey,
        fromEmail: config.fromEmail,
        fromName: config.fromName,
        toEmail: email,
        templateId: config.campaigns[campaign.id].templateId,
        data: buildTemplateData(booking, { fromEmail: config.fromEmail, survey }),
      });

      if (outcome.ok) {
        sent += 1;
        await markSent(campaign, bookingId, req.user.customerId);
        // On the booking's conversation. The words live in the SendGrid
        // template, so what is recorded is which email went, and when.
        await logEmail({
          club: req.user.customerId,
          direction: 'outbound',
          booking_id: bookingId,
          from_email: config.fromEmail,
          to_email: email,
          subject: campaign.label,
          body_text: `${campaign.label} sent from the SendGrid template (${config.campaigns[campaign.id].templateId}).`,
          sent_by: req.user.username,
          kind: campaign.id,
        });
      } else {
        failed += 1;
      }

      results.push({
        bookingId,
        email,
        status: outcome.ok ? 'sent' : 'failed',
        message: outcome.ok && veroNote ? `${outcome.message}. ${veroNote}` : outcome.message,
      });
    }

    res.json({
      campaign: campaign.id,
      dryRun,
      sent,
      failed,
      skipped,
      vero: handOverToVero,
      results,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
