/**
 * Booking vocabulary shared by the API routes, the export and the seed check —
 * the pipeline statuses, the row-to-JSON shape the SPA consumes, and the
 * tee-time extraction ported from `modules/utils/helpers.py`.
 */
import { BRAND } from './brand.js';


/** The funnel, in order. A booking only ever moves forward through these. */
export const PIPELINE_STAGES = ['Inquiry', 'Requested', 'Booked'];

/** Ends the pipeline early; neither counts toward conversion. */
export const TERMINAL_STATUSES = ['Rejected', 'Cancelled'];

export const ALL_STATUSES = [...PIPELINE_STAGES, ...TERMINAL_STATUSES];

/**
 * Retired spellings still found in older rows. 'Pending' is the Streamlit-era
 * 'Inquiry'; 'Confirmed' was a stage between Requested and Booked that has
 * been folded into Booked. Both are read as their replacement, never produced.
 */
export const LEGACY_STATUSES = { pending: 'Inquiry', confirmed: 'Booked' };

/** What a PATCH may set, and what `npm run check` treats as a status it understands. */
export const ALLOWED_STATUSES = [...ALL_STATUSES, 'Pending', 'Confirmed'];

export function normaliseStatus(status) {
  if (!status) return PIPELINE_STAGES[0];
  const text = String(status).trim();
  if (LEGACY_STATUSES[text.toLowerCase()]) return LEGACY_STATUSES[text.toLowerCase()];
  return ALL_STATUSES.find((known) => known.toLowerCase() === text.toLowerCase()) ?? text;
}

/**
 * Club ids that have a spelling of their own.
 *
 * `customer_id` is data — it is on every booking and every account — so it is
 * never renamed to follow the branding. The club this install is currently
 * branded as is spelled from BRAND, whatever id its rows happen to carry.
 */
const CLUB_NAMES = {
  teemail: BRAND.fullName,
  teemail_golf: BRAND.fullName,
  royal_dornoch: BRAND.fullName,
  royaldornoch: BRAND.fullName,
  dornoch: BRAND.fullName,
  demo_club: BRAND.fullName,
  streamsong: 'Streamsong Resort',
};

/** The club a user is scoped to, spelled for display. */
export function clubDisplayName(clubId) {
  if (!clubId) return BRAND.fullName;
  const key = String(clubId).trim().toLowerCase().replace(/-/g, '_');
  if (CLUB_NAMES[key]) return CLUB_NAMES[key];

  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

const TEE_TIME_PATTERNS = [
  /Tee\s+Time:\s*(\d{1,2}:\d{2}\s*[AP]M)/i,
  /Time:\s*(\d{1,2}:\d{2}\s*[AP]M)/i,
  // 24-hour spellings, as UK tee sheets write them.
  /Tee\s+Time:\s*(\d{1,2}:\d{2})(?!\s*[AP]M)/i,
  /Time:\s*(\d{1,2}:\d{2})(?!\s*[AP]M)/i,
];

/** Pull a tee time out of a stored enquiry email, or null if there is none. */
export function extractTeeTimeFromNote(note) {
  if (!note) return null;

  for (const pattern of TEE_TIME_PATTERNS) {
    const match = String(note).match(pattern);
    if (match) return match[1].trim().toUpperCase().replace(/\s+/g, ' ');
  }
  return null;
}

const NOT_SPECIFIED = 'Not Specified';

/** A `bookings` row as the SPA wants it: camelCase, numbers, plain strings. */
export function serialiseBooking(row) {
  const teeTime = text(row.tee_time) || extractTeeTimeFromNote(row.note) || NOT_SPECIFIED;

  return {
    id: row.id ?? null,
    bookingId: row.booking_id,
    club: row.club ?? null,

    guestEmail: text(row.guest_email),
    guestName: text(row.guest_name),
    contactPhone: text(row.contact_phone),

    date: dateOnly(row.date),
    teeTime,
    players: number(row.players),
    total: number(row.total),
    status: normaliseStatus(row.status),
    note: text(row.note),

    golfCourses: text(row.golf_courses),
    selectedTeeTimes: flatten(row.selected_tee_times),
    caddieRequirements: text(row.caddie_requirements),
    specialRequests: text(row.special_requests),
    formSubmittedAt: timestamp(row.form_submitted_at),

    hotelRequired: Boolean(row.hotel_required),
    hotelCheckin: dateOnly(row.hotel_checkin),
    hotelCheckout: dateOnly(row.hotel_checkout),
    lodgingNights: nullableNumber(row.lodging_nights),
    lodgingRooms: nullableNumber(row.lodging_rooms),
    lodgingRoomType: text(row.lodging_room_type),
    lodgingPreferences: text(row.lodging_preferences),
    lodgingCost: nullableNumber(row.lodging_cost),
    resortFeePerPerson: nullableNumber(row.resort_fee_per_person),
    resortFeeTotal: nullableNumber(row.resort_fee_total),

    preArrivalEmailSentAt: timestamp(row.pre_arrival_email_sent_at),
    postPlayEmailSentAt: timestamp(row.post_play_email_sent_at),

    // Trade account and payment state. Null throughout on an install that has
    // not run migration_add_tour_operators.sql.
    tourOperatorId: nullableNumber(row.tour_operator_id),
    paymentStatus: text(row.payment_status) || 'Unpaid',
    amountPaid: number(row.amount_paid),
    invoiceNumber: text(row.invoice_number),
    invoicedAt: dateOnly(row.invoiced_at),
    depositDueDate: dateOnly(row.deposit_due_date),
    balanceDueDate: dateOnly(row.balance_due_date),
    operatorStatusEmailSentAt: timestamp(row.operator_status_email_sent_at),
    operatorPaymentEmailSentAt: timestamp(row.operator_payment_email_sent_at),

    // The Stripe payment link last emailed, and the payment that settled it.
    paymentLinkId: text(row.stripe_payment_link_id),
    paymentLinkUrl: text(row.stripe_payment_link_url),
    paymentLinkAmount: row.payment_link_amount == null ? null : number(row.payment_link_amount),
    paymentLinkSentAt: timestamp(row.payment_link_sent_at),
    paymentLinkSentBy: text(row.payment_link_sent_by),
    stripePaidAt: timestamp(row.stripe_paid_at),
    stripeCheckoutSessionId: text(row.stripe_checkout_session_id),
    stripePaymentIntentId: text(row.stripe_payment_intent_id),
    lastPaymentAmount: row.stripe_last_payment_amount == null ? null : number(row.stripe_last_payment_amount),
    paymentReceiptSentAt: timestamp(row.payment_receipt_sent_at),
    prePlayClockStartedAt: timestamp(row.pre_play_clock_started_at),

    // Where this booking came from. An install without the column has only
    // ever taken enquiries, which is what 'teemail' means.
    source: row.source ?? 'teemail',
    importBatch: row.import_batch ?? null,
    importedAt: timestamp(row.imported_at),

    timestamp: timestamp(row.timestamp ?? row.created_at),
    customerConfirmedAt: timestamp(row.customer_confirmed_at),
    updatedAt: timestamp(row.updated_at),
    updatedBy: text(row.updated_by),
  };
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** NUMERIC comes back from pg as a string; the SPA does arithmetic on it. */
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Same, but keeps "column has no value" distinct from zero. */
function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * DATE columns arrive as a local-midnight Date. Reading the local parts (not
 * the UTC ones) keeps the calendar day the database stored, which is what the
 * SPA compares its date filters against.
 */
function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function timestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * `selected_tee_times` is TEXT on some installs and JSONB on others. The drawer
 * renders it directly, so it always has to come back as a string.
 */
function flatten(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${flatten(entry)}`)
      .join(', ');
  }
  return String(value);
}
