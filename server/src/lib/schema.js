/**
 * Runtime column detection.
 *
 * This dashboard runs against installs at different migration levels, so a
 * column the code knows about may simply not exist yet. Every query is built
 * from the columns the database actually has, and missing ones are selected as
 * NULL — the same tolerance `modules/database/bookings.py` has.
 */
import { query } from '../db.js';

/** Without these the dashboard cannot render a booking at all. */
export const REQUIRED_COLUMNS = [
  'booking_id',
  'guest_email',
  'date',
  'tee_time',
  'players',
  'total',
  'status',
  'note',
  'club',
];

/** Added by later migrations; absent ones fall back to NULL. */
export const OPTIONAL_COLUMNS = [
  'id',
  'timestamp',
  'created_at',
  'customer_confirmed_at',
  'updated_at',
  'updated_by',
  'hotel_required',
  'hotel_checkin',
  'hotel_checkout',
  'golf_courses',
  'selected_tee_times',
  'lodging_nights',
  'lodging_rooms',
  'lodging_room_type',
  'lodging_preferences',
  'lodging_cost',
  'resort_fee_per_person',
  'resort_fee_total',
  'guest_name',
  'contact_phone',
  'caddie_requirements',
  'special_requests',
  'form_submitted_at',
  'pre_arrival_email_sent_at',
  'post_play_email_sent_at',

  // migration_add_tour_operators.sql
  'tour_operator_id',
  'payment_status',
  'amount_paid',
  'invoice_number',
  'invoiced_at',
  'deposit_due_date',
  'balance_due_date',
  'operator_status_email_sent_at',
  'operator_payment_email_sent_at',

  // migration_add_booking_source.sql
  'source',
  'import_batch',
  'imported_at',

  // migration_add_stripe_payment_links.sql
  'stripe_payment_link_id',
  'stripe_payment_link_url',
  'payment_link_amount',
  'payment_link_sent_at',
  'payment_link_sent_by',
  'stripe_checkout_session_id',
  'stripe_paid_at',

  // migration_add_payment_receipts.sql
  'stripe_payment_intent_id',
  'stripe_last_payment_amount',
  'payment_receipt_sent_at',
  'pre_play_clock_started_at',
];

/** Every column of `tour_operators`; the table itself may not exist. */
export const OPERATOR_COLUMNS = [
  'id',
  'club',
  'name',
  'contact_name',
  'contact_email',
  'contact_phone',
  'account_code',
  'email_domains',
  'payment_terms_days',
  'deposit_percent',
  'deposit_due_days_before_play',
  'balance_due_days_before_play',
  'credit_limit',
  'currency',
  'on_hold',
  'active',
  'notes',
  'created_at',
  'updated_at',
  'updated_by',
];

const USER_COLUMNS = [
  'id',
  'username',
  // migration_add_password_reset.sql
  'email',
  'password_hash',
  'temp_password',
  'customer_id',
  'full_name',
  'is_active',
  'must_change_password',
  'last_login',

  // migration_add_user_management.sql
  'role',
  'created_at',
  'created_by',
  'invited_at',
];

/**
 * The lookup is cached per table so that a request does not pay for an
 * information_schema scan, and the promise itself is cached so concurrent
 * requests share one. A failed lookup is dropped so the next request retries.
 *
 * A *complete* schema is cached for the life of the process — nothing more can
 * appear. An incomplete one is re-checked every RECHECK_MS, because "incomplete"
 * is exactly the state a migration is about to fix, and somebody who has just
 * run one against a live database should not have to work out that the answer
 * is cached and restart the service to see it. The re-check costs one
 * information_schema query every 30 seconds, and only while something is
 * genuinely missing: the moment the install is fully migrated it caches for
 * good. An install that deliberately stays un-migrated pays two trivial
 * queries a minute for the privilege.
 */
const RECHECK_MS = 30_000;
const cache = new Map();

async function describe(table, known) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );

  const present = new Set(rows.map((row) => row.column_name));
  const has = (column) => present.has(column);

  return {
    has,
    present,
    /** No columns at all means the table itself is not there. */
    missing: present.size === 0,
    /** Every column this code knows about exists; nothing left to wait for. */
    complete: known.every((column) => present.has(column)),
    /**
     * A SELECT list covering every column the code reads, with the ones this
     * install lacks aliased to NULL so the shape is always the same.
     */
    selectList: known
      .map((column) => (present.has(column) ? `"${column}"` : `NULL AS "${column}"`))
      .join(', '),
  };
}

function cached(table, known) {
  const entry = cache.get(table);
  // `expiresAt` is undefined while the lookup is still in flight, which is a
  // hit: concurrent callers share the one query rather than starting their own.
  if (entry && (entry.expiresAt === undefined || entry.expiresAt > Date.now())) {
    return entry.promise;
  }

  const fresh = {
    promise: describe(table, known)
      .then((result) => {
        fresh.expiresAt = result.complete ? Infinity : Date.now() + RECHECK_MS;
        return result;
      })
      .catch((err) => {
        if (cache.get(table) === fresh) cache.delete(table);
        throw err;
      }),
  };

  cache.set(table, fresh);
  return fresh.promise;
}

export function getBookingColumns() {
  return cached('bookings', [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
}

export function getUserColumns() {
  return cached('dashboard_users', USER_COLUMNS);
}

export function getOperatorColumns() {
  return cached('tour_operators', OPERATOR_COLUMNS);
}

/**
 * Whether this install has run `migration_add_tour_operators.sql`.
 *
 * `describe` answers with an empty column set for a table that is not there,
 * rather than failing, so absence is a normal answer and the Tour Operators
 * page can explain itself instead of erroring.
 */
export async function hasOperatorsTable() {
  const columns = await getOperatorColumns();
  return columns.has('id') && columns.has('name');
}

/**
 * Whether a booking can say where it came from.
 *
 * Without it an uploaded tee sheet would be indistinguishable from an enquiry
 * TeeMail converted, and the conversion reports would overstate by the size of
 * the upload — so the importer refuses to run rather than corrupt them.
 */
export async function hasBookingSource() {
  const columns = await getBookingColumns();
  return columns.has('source') && columns.has('import_batch');
}

/** Whether a booking can carry an operator and its payment state. */
export async function hasOperatorBookingColumns() {
  const columns = await getBookingColumns();
  return columns.has('tour_operator_id') && columns.has('payment_status');
}

/** Every column of `password_resets`; the table exists only after the migration. */
const PASSWORD_RESET_COLUMNS = [
  'id',
  'user_id',
  'token_hash',
  'email',
  'expires_at',
  'used_at',
  'requested_ip',
  'created_at',
  // migration_add_user_management.sql
  'purpose',
];

/** Every column of `waitlist`; the table may not exist. */
const WAITLIST_COLUMNS = [
  'id', 'waitlist_id', 'guest_email', 'guest_name', 'requested_date', 'preferred_time',
  'time_flexibility', 'players', 'golf_course', 'status', 'priority', 'notes',
  'notification_sent', 'notification_sent_at', 'created_at', 'updated_at', 'club',
  // migration_add_waitlist_conversion.sql
  'converted_booking_id', 'converted_at',
];

const CHANGE_REQUEST_COLUMNS = [
  'id', 'booking_id', 'club', 'kind', 'message', 'requested_date', 'requested_time',
  'requested_players', 'status', 'auto_applied', 'days_before_play', 'resolved_at',
  'resolved_by', 'resolution_note', 'guest_email', 'requested_ip', 'created_at',
];

export function getChangeRequestColumns() {
  return cached('booking_change_requests', CHANGE_REQUEST_COLUMNS);
}

/** Whether guests can ask for changes online. */
export async function hasChangeRequests() {
  const columns = await getChangeRequestColumns();
  return columns.has('booking_id') && columns.has('kind');
}

export function getWaitlistColumns() {
  return cached('waitlist', WAITLIST_COLUMNS);
}

/**
 * Whether the waitlist can be reported on. The conversion link is the half
 * that matters: without it an entry cannot say which booking it became, which
 * is the one number the page exists to produce.
 */
export async function hasWaitlist() {
  const columns = await getWaitlistColumns();
  return columns.has('waitlist_id') && columns.has('converted_booking_id');
}

export function getPasswordResetColumns() {
  return cached('password_resets', PASSWORD_RESET_COLUMNS);
}

/**
 * Whether this install has run `migration_add_password_reset.sql`.
 *
 * Both halves matter: the table that holds outstanding links, and the column
 * that says where to send them. Without either, the login screen hides the
 * reset link rather than offering one that cannot work.
 */
export async function hasPasswordReset() {
  const [users, resets] = await Promise.all([getUserColumns(), getPasswordResetColumns()]);
  return users.has('email') && resets.has('token_hash') && resets.has('expires_at');
}

/**
 * Whether this install has run `migration_add_user_management.sql`.
 *
 * Roles are the half that matters: without them every account is equal and the
 * Users page cannot say who may administer, so it explains itself instead of
 * offering controls that would not stick.
 */
export async function hasUserManagement() {
  const users = await getUserColumns();
  return users.has('role') && users.has('created_at');
}

/** Whether an invitation can be told apart from a reset. */
export async function hasInvitePurpose() {
  const resets = await getPasswordResetColumns();
  return resets.has('purpose');
}

/** Only for tests and the seed path, which can create tables mid-process. */
export function resetSchemaCache() {
  cache.clear();
}

/**
 * The `updated_at` / `updated_by` half of an UPDATE's SET clause, skipping
 * whichever audit columns this install does not have.
 *
 * `startIndex` is the first free placeholder number in the caller's query;
 * the returned `values` are meant to be spliced in at that position.
 */
export function buildAuditSet(columns, startIndex, username) {
  const clauses = [];
  const values = [];

  if (columns.has('updated_at')) clauses.push('updated_at = NOW()');

  if (columns.has('updated_by') && username) {
    values.push(username);
    clauses.push(`updated_by = $${startIndex + values.length - 1}`);
  }

  return { clauses, values };
}
