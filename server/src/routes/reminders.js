/**
 * Operator reminder emails — booking status and payment.
 *
 * The browser names a campaign and a set of operator ids; the accounts and
 * their bookings are re-read here, scoped to the signed-in user's club, so a
 * request can never reach another club's trade partners.
 *
 * One email per operator, listing every booking of theirs that needs an answer.
 * Every booking that went into an email is stamped, so the same line is not
 * chased again tomorrow — see RESEND_GUARD_DAYS in the domain module.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { todayInClubZone } from '../lib/email-domain.js';
import { sendTemplateEmail } from '../lib/sendgrid.js';
import {
  OPERATOR_CAMPAIGN_IDS,
  RESEND_GUARD_DAYS,
  buildReminderTemplateData,
  getOperatorCampaign,
  publicReminderConfig,
  readReminderConfig,
  reminderReady,
  selectReminders,
  validateReminder,
} from '../lib/operator-emails-domain.js';
import { loadBookings, loadOperators } from './operators.js';

const router = Router();
router.use(requireAuth);

/** One run never writes to more than this many accounts. */
const MAX_BATCH = 100;

function resolveCampaign(req, res) {
  const id = req.query.campaign ?? req.body?.campaign;
  const campaign = getOperatorCampaign(id);
  if (!campaign) {
    res.status(400).json({
      error: `Unknown reminder campaign: ${id}. Expected one of ${OPERATOR_CAMPAIGN_IDS.join(', ')}.`,
    });
    return null;
  }
  return campaign;
}

/** What is configured for sending. */
router.get('/config', (req, res) => {
  res.json({
    ...publicReminderConfig(readReminderConfig()),
    resendGuardDays: RESEND_GUARD_DAYS,
  });
});

/** The reminders that would go out today, one per operator. */
router.get('/pending', async (req, res, next) => {
  const campaign = resolveCampaign(req, res);
  if (!campaign) return;
  const scope = req.query.scope === 'all' ? 'all' : 'due';

  try {
    const club = req.user.customerId;
    const today = todayInClubZone();
    const { days } = readReminderConfig().campaigns[campaign.id];
    const [operators, bookings] = await Promise.all([loadOperators(club), loadBookings(club)]);

    res.json({
      campaign: campaign.id,
      scope,
      days,
      today,
      resendGuardDays: RESEND_GUARD_DAYS,
      reminders: selectReminders(operators, bookings, { campaign, days, today, scope }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Send a campaign to the named operators.
 *
 * `dryRun` walks the same path — same selection, same rendered template data —
 * and stops short of the SendGrid call, so a preview reports exactly what a
 * real run would do, including which accounts it would refuse.
 */
router.post('/send', async (req, res, next) => {
  const campaign = resolveCampaign(req, res);
  if (!campaign) return;
  const { operatorIds, dryRun = false, scope = 'due' } = req.body ?? {};
  if (!Array.isArray(operatorIds) || operatorIds.length === 0) {
    return res.status(400).json({ error: 'operatorIds must be a non-empty array' });
  }
  if (operatorIds.length > MAX_BATCH) {
    return res.status(400).json({ error: `Too many operators in one run (max ${MAX_BATCH}).` });
  }

  const config = readReminderConfig();
  if (!dryRun && !reminderReady(config, campaign.id)) {
    return res.status(400).json({
      error: `Reminder email is not configured. Missing: ${config.missing.join(', ')}.`,
    });
  }

  try {
    const club = req.user.customerId;
    const today = todayInClubZone();
    const { days } = config.campaigns[campaign.id];
    const [operators, bookings] = await Promise.all([loadOperators(club), loadBookings(club)]);
    // Re-selected here rather than taken from the request: the browser may have
    // been looking at this list for an hour, and the club's own rules decide
    // what goes in an email, not the payload.
    const reminders = selectReminders(operators, bookings, {
      campaign,
      days,
      today,
      scope: scope === 'all' ? 'all' : 'due',
    });
    const byId = new Map(reminders.map((reminder) => [reminder.operatorId, reminder]));

    const wanted = new Set(operatorIds.map(Number));
    const results = [];
    let sent = 0;
    let failed = 0;

    for (const operatorId of wanted) {
      const reminder = byId.get(operatorId);
      if (!reminder) {
        failed += 1;
        results.push({
          operatorId,
          operatorName: null,
          email: null,
          bookings: 0,
          status: 'failed',
          message: 'Nothing is due for this account any more — refresh the list.',
        });
        continue;
      }

      const problem = validateReminder(reminder);
      if (problem) {
        failed += 1;
        results.push({
          operatorId,
          operatorName: reminder.operatorName,
          email: reminder.contactEmail || null,
          bookings: reminder.bookings.length,
          status: 'failed',
          message: problem,
        });
        continue;
      }

      const data = buildReminderTemplateData(reminder, {
        campaign,
        fromEmail: config.fromEmail,
        days,
        today,
      });

      if (dryRun) {
        const repeat = reminder.bookings.length - reminder.freshCount;
        results.push({
          operatorId,
          operatorName: reminder.operatorName,
          email: reminder.contactEmail,
          bookings: reminder.bookings.length,
          status: 'would_send',
          message:
            `Dry run — ${reminder.bookings.length} booking(s) would be listed` +
            (repeat ? `, ${repeat} of them chased in the last ${RESEND_GUARD_DAYS} days` : ''),
          preview: data,
        });
        continue;
      }

      const outcome = await sendTemplateEmail({
        apiKey: config.apiKey,
        fromEmail: config.fromEmail,
        fromName: config.fromName,
        toEmail: reminder.contactEmail,
        templateId: config.campaigns[campaign.id].templateId,
        data,
      });

      if (outcome.ok) {
        sent += 1;
        await markReminded(campaign, reminder, club);
      } else {
        failed += 1;
      }

      results.push({
        operatorId,
        operatorName: reminder.operatorName,
        email: reminder.contactEmail,
        bookings: reminder.bookings.length,
        status: outcome.ok ? 'sent' : 'failed',
        message: outcome.message,
      });
    }

    res.json({ campaign: campaign.id, dryRun, sent, failed, results });
  } catch (err) {
    next(err);
  }
});

/**
 * Stamp every booking that went into the email.
 *
 * The stamp is per booking rather than per operator because that is what the
 * resend guard reads: an account chased last week about four bookings should
 * still be chased today about the fifth one that has just fallen due.
 */
async function markReminded(campaign, reminder, club) {
  await query(
    `UPDATE public.bookings SET "${campaign.column}" = NOW()
      WHERE booking_id = ANY($1::text[]) AND club = $2`,
    [reminder.bookings.map((line) => line.bookingId), club],
  );
}

export default router;
