/**
 * The columns the dashboard reads from each table.
 *
 * The schema is guaranteed by db/migrations, which the server applies before
 * it listens, so these are plain constants: nothing here asks the database
 * what it has. A new column arrives with a migration and is added here in the
 * same change.
 *
 * The one place the schema is not ours alone is the core API, which writes to
 * the same tables — but it writes only columns the migrations create, so the
 * dashboard does not need to probe for those either.
 */

/** Every bookings column the dashboard reads. */
const BOOKING_COLUMNS = [
  'id',
  'booking_id',
  'guest_email',
  'date',
  'tee_time',
  'players',
  'total',
  'status',
  'note',
  'club',
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
  'tour_operator_id',
  'payment_status',
  'amount_paid',
  'invoice_number',
  'invoiced_at',
  'deposit_due_date',
  'balance_due_date',
  'operator_status_email_sent_at',
  'operator_payment_email_sent_at',
  'source',
  'import_batch',
  'imported_at',
  'stripe_payment_link_id',
  'stripe_payment_link_url',
  'payment_link_amount',
  'payment_link_sent_at',
  'payment_link_sent_by',
  'stripe_checkout_session_id',
  'stripe_paid_at',
  'stripe_payment_intent_id',
  'stripe_last_payment_amount',
  'payment_receipt_sent_at',
  'pre_play_clock_started_at',
];

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
  'email',
  'password_hash',
  'temp_password',
  'customer_id',
  'full_name',
  'is_active',
  'must_change_password',
  'last_login',
  'role',
  'created_at',
  'created_by',
  'invited_at',
  'session_version',
];

/** A quoted SELECT list. */
function selectList(columns) {
  return columns.map((column) => `"${column}"`).join(', ');
}

export const BOOKING_SELECT = selectList(BOOKING_COLUMNS);
export const OPERATOR_SELECT = selectList(OPERATOR_COLUMNS);
export const USER_SELECT = selectList(USER_COLUMNS);

/**
 * The `updated_at` / `updated_by` half of an UPDATE's SET clause.
 *
 * `startIndex` is the first free placeholder number in the caller's query;
 * the returned `values` are meant to be spliced in at that position.
 */
export function buildAuditSet(startIndex, username) {
  const clauses = ['updated_at = NOW()'];
  const values = [];
  if (username) {
    values.push(username);
    clauses.push(`updated_by = $${startIndex}`);
  }
  return { clauses, values };
}
