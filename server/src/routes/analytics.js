import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import { BOOKING_SELECT } from '../lib/schema.js';
import { GRANULARITIES, buildAnalytics } from '../lib/analytics-domain.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE club = $1`, [
      req.user.customerId,
    ]);

    const all = rows.map(serialiseBooking);
    // Trade mix reads better as account names than as ids.
    const operatorNames = await loadOperatorNames(req.user.customerId);
    const { from, to, granularity } = req.query;

    const current = all.filter((booking) => within(booking, from, to));
    // The comparison window is the same length immediately before `from`, so a
    // "next 90 days" view is judged against the 90 days before it rather than
    // against an arbitrary calendar period. It needs both ends to be defined.
    const window = previousWindow(from, to);
    const previous = window ? all.filter((b) => within(b, window.from, window.to)) : null;

    res.json({
      ...buildAnalytics(current, {
        granularity: resolveGranularity(granularity, from, to),
        previous,
        operatorNames,
      }),
      range: { from: from ?? null, to: to ?? null },
      comparison: window,
    });
  } catch (err) {
    next(err);
  }
});

/** id → account name for this club's operators. */
async function loadOperatorNames(club) {
  try {
    const { rows } = await query('SELECT id, name FROM public.tour_operators WHERE club = $1', [club]);
    return new Map(rows.map((row) => [row.id, row.name]));
  } catch {
    // Names are a nicety; the report is worth more than the labels.
    return new Map();
  }
}

function within(booking, from, to) {
  if (!booking.date) return false;
  if (from && booking.date < from) return false;
  if (to && booking.date > to) return false;
  return true;
}

/** Daily ticks turn to mush past a few months, so the default follows the span. */
function resolveGranularity(requested, from, to) {
  if (GRANULARITIES.includes(requested)) return requested;
  const days = spanDays(from, to);
  if (days === null || days > 365) return 'month';
  if (days > 92) return 'week';
  return 'day';
}

function previousWindow(from, to) {
  const days = spanDays(from, to);
  if (days === null) return null;

  const start = Date.parse(`${from}T00:00:00Z`);
  const previousTo = new Date(start - 86_400_000);
  const previousFrom = new Date(previousTo.getTime() - days * 86_400_000);

  return {
    from: previousFrom.toISOString().slice(0, 10),
    to: previousTo.toISOString().slice(0, 10),
  };
}

function spanDays(from, to) {
  if (!from || !to) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 86_400_000);
}

export { buildAnalytics };
export default router;
