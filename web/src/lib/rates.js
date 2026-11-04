/**
 * The club's green fee, per player, as a starting figure for a booking taken
 * by hand.
 *
 * A copy of the rate card the email bot quotes from (tour_operator_config.py
 * in TeeMailSG). It is only ever a prefill: the figure sits in the form, the
 * person taking the booking can see it and change it, and whatever they save
 * is what the booking costs. Nothing is priced from this without somebody
 * looking at it, which is the difference from the bot's copy.
 *
 * A year past the end of the card is priced at its last year, as the bot does.
 */
export const RATE_CARD = {
  2026: { visitor: 325, tourOperator: 285 },
  2027: { visitor: 385, tourOperator: 325 },
};

const LAST_YEAR = Math.max(...Object.keys(RATE_CARD).map(Number));

/** The suggested price per player for a round on `date`, or null with no date. */
export function suggestedRate(date, { tourOperator = false } = {}) {
  const year = Number(String(date ?? '').slice(0, 4));
  if (!year) return null;
  const card = RATE_CARD[year] ?? RATE_CARD[LAST_YEAR];
  return tourOperator ? card.tourOperator : card.visitor;
}
