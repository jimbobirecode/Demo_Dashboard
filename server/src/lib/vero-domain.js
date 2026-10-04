/**
 * The Club Vero handover, as rules rather than as a network call.
 *
 * The post-play email already goes to every guest a couple of days after they
 * play, and it already asks them how it went. What it could not do is keep the
 * answer: a reply lands in an inbox, and nothing counts it, scores it, or tells
 * anyone the same complaint has now arrived three times.
 *
 * Club Vero does all of that, so the two are joined at the one moment they are
 * both about: the send. Before the email goes out this dashboard hands the
 * round to Vero, Vero mints a survey for it, and the link comes back as a merge
 * field the template drops in. The guest still gets one email, from the club,
 * in the club's own voice — and the answer lands somewhere that can act on it.
 *
 * Everything here is pure, for the same reason `email-domain.js` is: the
 * decisions worth being sure about — is it configured, which campaigns does it
 * apply to, what exactly is sent about a guest — should be readable and
 * testable without an API key or a running Vero.
 */

/** Campaigns that carry a survey link unless the environment says otherwise. */
const DEFAULT_CAMPAIGNS = ['post_play'];

/** The partner name Vero files these rounds under, absent an override. */
const DEFAULT_SOURCE = 'dornoch';

/**
 * The integration as the environment has it, with the key reduced to a yes/no
 * — this shape is handed to the browser, so it must never carry the key.
 *
 * Absent `VERO_BASE_URL` and `VERO_PARTNER_KEY` the whole thing is off and the
 * email campaigns behave exactly as they did before it existed. That is the
 * important default: a half-configured integration must not quietly change
 * what a club's guests receive.
 */
export function readVeroConfig(env = process.env) {
  const baseUrl = trimSlashes(env.VERO_BASE_URL);
  const apiKey = env.VERO_PARTNER_KEY ?? null;

  const campaigns = parseList(env.VERO_CAMPAIGNS, DEFAULT_CAMPAIGNS);

  const missing = [];
  if (!baseUrl) missing.push('VERO_BASE_URL');
  if (!apiKey) missing.push('VERO_PARTNER_KEY');

  return {
    enabled: missing.length === 0,
    baseUrl,
    apiKey,
    source: (env.VERO_PARTNER_SOURCE || DEFAULT_SOURCE).trim().toLowerCase(),
    /** The club's slug in Vero. Only a group deployment needs it. */
    site: (env.VERO_SITE || '').trim() || null,
    campaigns,
    missing,
  };
}

/** Strips the key, for anything that crosses the wire. */
export function publicVeroConfig(config) {
  const { apiKey, ...rest } = config;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

/**
 * Whether this campaign's emails should carry a survey link.
 *
 * Pre-arrival is deliberately not in the default list. A survey link in a
 * welcome email asks somebody to rate a round they have not played yet.
 */
export function veroEnabledFor(config, campaignId) {
  return config.enabled && config.campaigns.includes(campaignId);
}

/**
 * What Vero is told about a round.
 *
 * Only what it needs to ask the question and deliver it: who played, when,
 * where, and how to reach them. Not the lodging, not the total, not the
 * caddie notes — a feedback product has no use for any of it, and the smallest
 * payload that works is the one that stays correct when either side changes.
 *
 * `external_ref` is the booking reference, and it is what makes the handover
 * safe to repeat. Vero keys on it, so a retry after a timeout, a re-run of the
 * catch-up window, or a deliberate resend all land on the same survey rather
 * than minting a second one and stranding whatever the guest already typed.
 */
export function buildRoundPayload(booking, { site = null, dryRun = false } = {}) {
  const payload = {
    external_ref: booking.bookingId,
    play_date: booking.date,
    guest_name: booking.guestName?.trim() || '',
    guest_email: booking.guestEmail ?? '',
    guest_phone: booking.contactPhone?.trim() || '',
    course_name: booking.golfCourses?.trim() || '',
    tee_time: booking.teeTime || '',
  };

  // Sent only where there is a real figure. Vero does not use spend to decide
  // whether a handed-over round earns a survey — the club already decided that
  // by sending it — so a zero here would be a fact about the booking, not a
  // threshold, and an invented one is worse than a missing one.
  if (Number.isFinite(booking.players) && booking.players > 0) payload.players = booking.players;
  if (Number.isFinite(booking.total) && booking.total > 0) payload.spend_amount = booking.total;

  if (site) payload.site = site;
  if (dryRun) payload.dry_run = true;

  return payload;
}

/**
 * The merge fields a survey link adds to the SendGrid template data.
 *
 * `feedback_url` is the same value under the name an older template is likely
 * to have been written against, on exactly the reasoning `buildTemplateData`
 * already applies to `booking_ref` and `play_date`: both spellings are sent so
 * a template from either era renders.
 */
export function surveyTemplateData({ surveyUrl, unsubscribeUrl } = {}) {
  if (!surveyUrl) return {};
  return {
    survey_url: surveyUrl,
    feedback_url: surveyUrl,
    unsubscribe_url: unsubscribeUrl ?? '',
  };
}

function parseList(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function trimSlashes(value) {
  return String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
}
