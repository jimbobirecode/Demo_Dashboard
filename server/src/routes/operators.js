/**
 * Tour operator accounts: who the trade partners are, what credit they trade
 * on, and how a booking is attached to one.
 *
 * Every route is scoped to the signed-in user's club, on both sides of the
 * join — an operator id from the browser is never trusted to belong to the
 * caller's club, it is checked.
 *
 * Installs that have not run `migration_add_tour_operators.sql` get a 409 with
 * the migration named, rather than a 500 about a missing relation.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import {
  buildAuditSet,
  getBookingColumns,
  getOperatorColumns,
  hasOperatorBookingColumns,
  hasOperatorsTable,
} from '../lib/schema.js';
import {
  AGEING_BANDS,
  PAYMENT_STATUSES,
  attachOperators,
  buildOperatorIndex,
  describeTerms,
  paymentState,
  portfolioTotals,
  serialiseOperator,
  suggestOperators,
  summariseAll,
  toOperatorColumns,
  validateOperator,
} from '../lib/operators-domain.js';
import { todayInClubZone } from '../lib/email-domain.js';

const router = Router();
router.use(requireAuth);

const MIGRATION = 'migration_add_tour_operators.sql';

/**
 * Refuses the request when the table is not there, and says what to run. Every
 * route that touches `tour_operators` goes through this first.
 */
async function requireOperatorSchema(res) {
  if (await hasOperatorsTable()) return true;
  res.status(409).json({
    error:
      `This database has no tour_operators table. Run ${MIGRATION} to add it — ` +
      'the dashboard picks it up within 30 seconds, with no restart. If this ' +
      'persists after the migration has run, the dashboard is pointed at a ' +
      'different database than the one it was run against.',
    migration: MIGRATION,
  });
  return false;
}

export async function loadOperators(club) {
  const columns = await getOperatorColumns();
  const { rows } = await query(
    `SELECT ${columns.selectList} FROM public.tour_operators
      WHERE club = $1 ORDER BY name ASC`,
    [club],
  );
  return rows.map(serialiseOperator);
}

export async function loadBookings(club) {
  const columns = await getBookingColumns();
  const { rows } = await query(
    `SELECT ${columns.selectList} FROM public.bookings WHERE club = $1`,
    [club],
  );
  return rows.map(serialiseBooking);
}

/**
 * The whole trade book: every account with its exposure and ageing, the direct
 * bookings as one pseudo-account, and the club-wide roll-up.
 */
router.get('/', async (req, res, next) => {
  if (!(await requireOperatorSchema(res))) return;

  try {
    const club = req.user.customerId;
    const today = todayInClubZone();
    const [operators, bookings] = await Promise.all([loadOperators(club), loadBookings(club)]);

    const { operators: summaries, direct } = summariseAll(operators, bookings, { today });
    const byId = new Map(summaries.map((summary) => [summary.operatorId, summary]));

    res.json({
      today,
      ageingBands: AGEING_BANDS,
      paymentStatuses: PAYMENT_STATUSES,
      tracking: await hasOperatorBookingColumns(),
      operators: operators.map((operator) => ({
        ...operator,
        terms: describeTerms(operator),
        account: byId.get(operator.id),
      })),
      direct,
      totals: portfolioTotals(summaries),
    });
  } catch (err) {
    // Say what went wrong on the page itself: a bare "Internal server error"
    // leaves the club unable to tell a data problem from a schema one without
    // digging through the host's logs. Only signed-in staff reach this route.
    console.error('[api] loading tour operators failed:', err);
    res.status(500).json({ error: `Could not load the tour operators: ${err.message}` });
  }
});

/**
 * One account in full: the terms, the roll-up and every booking on it with its
 * derived payment state — the statement somebody reads before making a call.
 */
router.get('/:id', async (req, res, next) => {
  if (!(await requireOperatorSchema(res))) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown operator' });

  try {
    const club = req.user.customerId;
    const today = todayInClubZone();
    const [operators, bookings] = await Promise.all([loadOperators(club), loadBookings(club)]);

    const operator = operators.find((entry) => entry.id === id);
    if (!operator) return res.status(404).json({ error: 'Operator not found' });

    const { operators: summaries, groups } = summariseAll(operators, bookings, { today });
    const theirs = groups.get(id) ?? [];

    res.json({
      today,
      operator: { ...operator, terms: describeTerms(operator) },
      account: summaries.find((summary) => summary.operatorId === id),
      bookings: theirs
        .map((booking) => ({ ...booking, payment: paymentState(booking, operator, { today }) }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  if (!(await requireOperatorSchema(res))) return;

  const problem = validateOperator(req.body);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const columns = await getOperatorColumns();
    const values = toOperatorColumns(req.body);
    const audit = columns.has('updated_by') ? { updated_by: req.user.username } : {};
    const record = { club: req.user.customerId, ...values, ...audit };

    const names = Object.keys(record).filter((name) => columns.has(name) || name === 'club');
    const placeholders = names.map((_, index) => `$${index + 1}`);

    const { rows } = await query(
      `INSERT INTO public.tour_operators (${names.map((n) => `"${n}"`).join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING ${columns.selectList}`,
      names.map((name) => record[name]),
    );

    res.status(201).json({ operator: serialiseOperator(rows[0]) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An operator with that name already exists.' });
    }
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  if (!(await requireOperatorSchema(res))) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown operator' });

  const problem = validateOperator(req.body);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const columns = await getOperatorColumns();
    const values = toOperatorColumns(req.body);
    const names = Object.keys(values).filter((name) => columns.has(name));

    const sets = names.map((name, index) => `"${name}" = $${index + 1}`);
    const params = names.map((name) => values[name]);
    if (columns.has('updated_at')) sets.push('updated_at = NOW()');
    if (columns.has('updated_by')) {
      params.push(req.user.username);
      sets.push(`updated_by = $${params.length}`);
    }

    params.push(id, req.user.customerId);

    const { rows } = await query(
      `UPDATE public.tour_operators SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND club = $${params.length}
      RETURNING ${columns.selectList}`,
      params,
    );

    if (!rows[0]) return res.status(404).json({ error: 'Operator not found' });
    res.json({ operator: serialiseOperator(rows[0]) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An operator with that name already exists.' });
    }
    next(err);
  }
});

/**
 * Retires an account rather than deleting it: the bookings it carried are real
 * history, and an operator with money against their name must not be able to
 * vanish along with the debt. Only an account with no bookings is removed.
 */
router.delete('/:id', async (req, res, next) => {
  if (!(await requireOperatorSchema(res))) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown operator' });

  try {
    const club = req.user.customerId;
    const [operators, bookings] = await Promise.all([loadOperators(club), loadBookings(club)]);
    const operator = operators.find((entry) => entry.id === id);
    if (!operator) return res.status(404).json({ error: 'Operator not found' });

    const index = buildOperatorIndex([operator]);
    const attached = attachOperators(bookings, index).filter((booking) => booking.operatorId === id);

    if (attached.length) {
      const columns = await getOperatorColumns();
      if (!columns.has('active')) {
        return res.status(409).json({
          error: `${operator.name} has ${attached.length} booking(s) and cannot be deleted.`,
        });
      }
      const { rows } = await query(
        `UPDATE public.tour_operators SET active = FALSE
          WHERE id = $1 AND club = $2 RETURNING ${columns.selectList}`,
        [id, club],
      );
      return res.json({
        retired: true,
        operator: serialiseOperator(rows[0]),
        message: `${operator.name} has ${attached.length} booking(s), so the account was retired rather than deleted.`,
      });
    }

    await query('DELETE FROM public.tour_operators WHERE id = $1 AND club = $2', [id, club]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Trade domains the club is doing business with and has no account for.
 *
 * This is the identification step run from the data: the club does not have to
 * remember who its operators are, the repeat business names them.
 */
router.get('/suggestions/unmatched', async (req, res, next) => {
  if (!(await requireOperatorSchema(res))) return;

  const threshold = Number(req.query.threshold);

  try {
    const club = req.user.customerId;
    const [operators, bookings] = await Promise.all([loadOperators(club), loadBookings(club)]);
    const index = buildOperatorIndex(operators);

    const suggestions = suggestOperators(bookings, index, {
      threshold: Number.isInteger(threshold) && threshold > 0 ? threshold : undefined,
    });

    // Bookings whose *text* names an existing operator — offered for a human to
    // confirm, never applied, because prose is not evidence of an account.
    const needsConfirming = attachOperators(bookings, index)
      .filter((booking) => booking.operatorMatch === 'name')
      .map(({ bookingId, guestName, guestEmail, date, total, status, operatorId, operatorName }) => ({
        bookingId,
        guestName,
        guestEmail,
        date,
        total,
        status,
        operatorId,
        operatorName,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    res.json({ suggestions, needsConfirming });
  } catch (err) {
    next(err);
  }
});

/**
 * Attach bookings to an account by hand — used both to accept a suggestion and
 * to correct a mis-identified booking. `operatorId: null` detaches.
 */
router.post('/assign', async (req, res, next) => {
  if (!(await requireOperatorSchema(res))) return;

  const { bookingIds, operatorId = null } = req.body ?? {};
  if (!Array.isArray(bookingIds) || !bookingIds.length) {
    return res.status(400).json({ error: 'bookingIds must be a non-empty array' });
  }
  if (operatorId !== null && !Number.isInteger(Number(operatorId))) {
    return res.status(400).json({ error: 'operatorId must be a number or null' });
  }

  const columns = await getBookingColumns();
  if (!columns.has('tour_operator_id')) {
    return res.status(409).json({
      error: `This database has no tour_operator_id column on bookings. Run ${MIGRATION} to add it — the dashboard picks it up within 30 seconds, with no restart.`,
      migration: MIGRATION,
    });
  }

  try {
    const club = req.user.customerId;

    // An operator id is only accepted if it is this club's. Without this check
    // one club could move its bookings onto another club's account.
    if (operatorId !== null) {
      const { rows } = await query(
        'SELECT id FROM public.tour_operators WHERE id = $1 AND club = $2',
        [Number(operatorId), club],
      );
      if (!rows.length) return res.status(404).json({ error: 'Operator not found' });
    }

    const audit = buildAuditSet(columns, 4, req.user.username);
    const { rows } = await query(
      `UPDATE public.bookings
          SET tour_operator_id = $1${audit.clauses.length ? `, ${audit.clauses.join(', ')}` : ''}
        WHERE booking_id = ANY($2::text[]) AND club = $3
      RETURNING booking_id`,
      [operatorId === null ? null : Number(operatorId), bookingIds, club, ...audit.values],
    );

    res.json({ updated: rows.length, bookingIds: rows.map((row) => row.booking_id) });
  } catch (err) {
    next(err);
  }
});

export default router;
