/**
 * What Claude makes of an inbound email: what it is, what it says, and a
 * reply the club can send.
 *
 * The Inbox has always been built to show this -- `intent`, `summary` and
 * `draft_reply` are columns from migration 0004, and the page tells the reader
 * "Claude has written a draft from the club's own information". On the demo
 * the core API fills them in. County Louth's mailbox is in front of the email
 * bot instead, which records a type and nothing else, so every email arrived
 * as 'other' with no summary and no draft and the club read each one cold.
 *
 * This is the missing half. It runs as a sweep rather than inline, because
 * the rows are created by a database trigger (migration 0019) that the server
 * never hears about.
 *
 * WHAT IT WILL AND WILL NOT DO
 *
 * It describes and drafts. It does not decide. A draft is put in the box the
 * composer opens with, already editable, and nothing is ever sent without a
 * person pressing send -- so the worst case of a bad draft is a staff member
 * deleting it, not a guest receiving it.
 *
 * It also never closes anything. Whether an email still needs a person is the
 * bot's call and the club's; this pass only fills in what the email is about.
 * The one exception is review_reason, which it rewrites from "the bot did not
 * classify this one" to something that actually says why the email is sitting
 * there -- which is the sentence the club reads first.
 *
 * It is told, in the system prompt, not to invent. The club's real prices,
 * dates and availability are not in this process, so a draft that states one
 * would be a confident lie in the club's own voice. Where the answer needs a
 * fact it does not have, it leaves a marked gap for a person to fill.
 *
 * PRIVACY. The guest's email reaches Anthropic's API. That is what makes any
 * of this possible, and it is worth saying out loud rather than discovering.
 */
import Anthropic from '@anthropic-ai/sdk';
import { BRAND } from './brand.js';
import { logger } from './logger.js';

const log = logger.child('triage');

/**
 * Claude Opus 5.5. A guest-facing draft in the club's voice is the kind of
 * judgement worth the better model, and the volume is a golf club's mailbox,
 * not a feed. INBOX_TRIAGE_MODEL moves it if that trade stops being worth it.
 */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * The vocabulary migration 0004 defined for email_messages.intent, which is
 * what the Inbox filters and reports on. The model is held to exactly this
 * list by the schema below, so it cannot invent a category the dashboard has
 * no idea what to do with.
 */
export const INTENTS = [
  'new_enquiry',
  'booking_reply',
  'change_request',
  'cancellation',
  'question',
  'complaint',
  'operator_request',
  'not_booking',
  'other',
];

/**
 * Structured output, so the reply is the shape the database expects rather
 * than prose to be picked apart. `additionalProperties: false` and the
 * required list mean a response that parses is a response we can store.
 */
export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: INTENTS,
      description: 'What the sender wants, in the dashboard’s own vocabulary.',
    },
    summary: {
      type: 'string',
      description:
        'One sentence, under 140 characters, saying what this email is about. ' +
        'It is the line the club reads in a list of twenty, so it names the ' +
        'specifics -- dates, numbers, the booking reference -- not the category.',
    },
    needs_person: {
      type: 'boolean',
      description: 'True when a member of staff has to decide something before this can be answered.',
    },
    reason: {
      type: 'string',
      description:
        'Under 120 characters: why this is waiting for someone, or why it is not. ' +
        'Shown under the summary in the Inbox.',
    },
    draft_reply: {
      type: 'string',
      description:
        'A reply the club could send, in plain text, signed off by the club. ' +
        'Empty string when a reply would be guesswork. Every fact not present ' +
        'in the email or the booking details is written as a [square bracket] ' +
        'gap for a person to fill in.',
    },
    confidence: {
      type: 'number',
      description: '0 to 1: how sure you are of the intent.',
    },
  },
  required: ['intent', 'summary', 'needs_person', 'reason', 'draft_reply', 'confidence'],
  additionalProperties: false,
};

/** The club's own details, so a draft sounds like the club and not like software. */
export function clubBrief(brand = BRAND) {
  return [
    `Club: ${brand.fullName}${brand.name && brand.name !== brand.fullName ? ` (known as ${brand.name})` : ''}`,
    brand.address ? `Address: ${brand.address}` : null,
    brand.phone ? `Telephone: ${brand.phone}` : null,
    brand.defaultCourse ? `Course: ${brand.defaultCourse}` : null,
    `Currency: ${brand.currency}. Dates are read and written as ${brand.locale}, in ${brand.timeZone}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

export const SYSTEM_PROMPT = `You read email sent to a golf club's visitor booking desk and prepare it for the staff member who will answer it.

You are given one email, the club's details, and the booking it belongs to when there is one. Return the structured object you have been given the schema for. Nothing you write is sent to anybody: the draft opens in a composer for a member of staff to read, change and send themselves.

Write the draft as the club, in British or Irish English, warm and brief -- the way a golf club writes to a visitor. No marketing, no exclamation marks, no "I hope this email finds you well". Sign off with the club's name.

The draft is a reply to whoever sent the email, and to nobody else. A booking's lead guest is the name on the tee sheet, not necessarily the person writing: much of a club's trade arrives through tour operators and secretaries who book for other people. Greet the sender, never the lead guest, and where you do not know the sender's name open with "Hello," rather than guessing at one. Write about the lead guest in the third person when the sender is somebody else -- their booking is what the email is about, but they are not the person being written to.

The one rule that matters: do not invent. You do not have the tee sheet, the green fees, or anything about availability. If answering needs a fact you have not been given, write it as a [gap in square brackets] for a person to fill in -- "[confirm the rate for that date]" -- and never a plausible-looking number. A draft with four honest gaps is useful. A draft with one invented price is a lie in the club's name, and worse than no draft at all.

If a reply would be guesswork from end to end, return an empty draft_reply and say why in reason.

Mark needs_person true whenever answering requires a decision, a price, or a look at the tee sheet. Most enquiries do. Mark it false only for an email that needs nothing from the club -- an automated bounce, a thank-you, something that is not about a booking at all.`;

/**
 * A date as a plain calendar day.
 *
 * `bookings.date` is a DATE column, so pg hands back a Date object, and
 * dropping that straight into the prompt renders "Sat Apr 24 2027 00:00:00
 * GMT+0000 (Coordinated Universal Time)" -- noise, and a time and a zone that
 * the column does not actually hold. Written out as the calendar day it is.
 */
export function asDay(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/** The email, its booking and the guest's history, as the model sees them. */
export function buildUserContent({ email, booking = null, brand = BRAND }) {
  const lines = [
    'THE CLUB',
    clubBrief(brand),
    '',
    'THE EMAIL',
    `From: ${email.fromEmail ?? 'unknown'}`,
    `Received: ${email.createdAt ?? 'unknown'}`,
    `Subject: ${email.subject?.trim() || '(no subject)'}`,
    '',
    (email.bodyText ?? '').trim() || '(no body)',
  ];

  if (booking) {
    lines.push(
      '',
      'THE BOOKING THIS IS ABOUT',
      `Reference: ${booking.bookingId}`,
      `Lead guest: ${booking.guestName ?? 'unknown'}${wroteItThemselves(email, booking) ? ' (who sent this email)' : ' (the name on the booking - NOT the sender of this email)'}`,
      `Status: ${booking.status ?? 'unknown'}`,
      `Date: ${asDay(booking.date) ?? 'not set'}`,
      `Tee time: ${booking.teeTime ?? 'not set'}`,
      `Players: ${booking.players ?? 'unknown'}`,
    );
  } else {
    lines.push('', 'No booking is attached to this email.');
  }

  return lines.join('\n');
}

/**
 * Whether the email came from the lead guest's own address.
 *
 * It decides how the booking's name is labelled in the prompt, and so who the
 * draft greets: the lead guest where they wrote themselves, and otherwise
 * whoever did write, with the lead guest spoken about rather than to.
 */
function wroteItThemselves(email, booking) {
  const sender = String(email?.fromEmail ?? '')
    .trim()
    .toLowerCase();
  const lead = String(booking?.guestEmail ?? '')
    .trim()
    .toLowerCase();
  return Boolean(sender) && sender === lead;
}

/** Keep what the model returned inside what the database and the screen expect. */
export function normaliseTriage(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('the model returned nothing usable');
  const intent = INTENTS.includes(raw.intent) ? raw.intent : 'other';
  const text = (value, limit) => {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit - 1).trimEnd()}…` : trimmed;
  };
  const confidence = Number(raw.confidence);
  return {
    intent,
    summary: text(raw.summary, 200),
    reason: text(raw.reason, 200),
    draftReply: String(raw.draft_reply ?? '').trim(),
    needsPerson: raw.needs_person !== false,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : null,
  };
}

/** Whether triage can run at all. Absent a key it is simply off, not broken. */
export function triageConfig(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY ?? null;
  return {
    apiKey,
    configured: Boolean(apiKey),
    model: env.INBOX_TRIAGE_MODEL ?? DEFAULT_MODEL,
    // Opus 5.5 defaults to medium; stated here so it is one edit to change.
    effort: env.INBOX_TRIAGE_EFFORT ?? 'medium',
  };
}

/**
 * Read one email. `client` is injectable so the tests never call the API.
 */
export async function triageEmail({ email, booking = null, brand = BRAND, client, env = process.env }) {
  const config = triageConfig(env);
  if (!client && !config.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set, so the Inbox cannot be triaged');
  }
  const anthropic = client ?? new Anthropic({ apiKey: config.apiKey });

  const response = await anthropic.messages.parse({
    model: config.model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: config.effort,
      format: { type: 'json_schema', schema: TRIAGE_SCHEMA },
    },
    messages: [{ role: 'user', content: buildUserContent({ email, booking, brand }) }],
  });

  // A safety decline is not a crash: the email stays as it is, unread by the
  // model, and a person reads it. Checked before the content, which is empty.
  if (response.stop_reason === 'refusal') {
    throw new Error(`the model declined to read this email (${response.stop_details?.category ?? 'no category'})`);
  }
  if (!response.parsed_output) {
    throw new Error('the model’s answer did not match the schema');
  }
  return normaliseTriage(response.parsed_output);
}

export { log as triageLog };
