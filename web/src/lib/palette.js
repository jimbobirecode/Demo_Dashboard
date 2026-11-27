/**
 * Chart colours, as literals.
 *
 * The dashboard's colours are the custom properties at the top of `theme.css`;
 * these are the same colours as literals, because Recharts needs a real value
 * for `fill`, not a `var()`.
 *
 * LIGHT THEME. Charts are drawn on a white card (#FFFFFF), and every value
 * here was measured against it. The ratios quoted are WCAG contrast against
 * white; a mark needs 3:1, text 4.5:1.
 *
 *   SERIES         #1A5E58  7.54:1   TeeMail teal, the one accent
 *   PIPELINE_RAMP  3.36, 4.23, 5.65, 7.54:1 -- one teal hue, DARKENING toward
 *                  completion (the dark theme's ramp brightened)
 *   CATEGORICAL    #2F5D7C 7.05, #C2410C 5.18, #8A6D1F 4.90 -- worst pair
 *                  dE 47, and each is dE 25+ from the teal series
 *   Rejected / overdue #B91C1C 6.47   Cancelled / closed #6B7280 4.83
 *
 * Two colours from the dark theme must not come back on this surface: gorse
 * gold #C9A227 is 2.4:1 on white and amber #F59E0B 2.2:1 -- both too faint to
 * read as a line or a bar. The deep gold above is the same hue, darkened.
 *
 * What was NOT re-run for this surface is the colour-vision-deficiency
 * simulation the dark ramps were validated with. Status is always written out
 * in words beside its colour, which is what makes that safe to follow up
 * rather than block on.
 */

/** The card the charts are drawn on, and the ink that sits on it. */
export const SURFACE = '#FFFFFF';
export const SURFACE_SUNK = '#F6F7F9';
export const GRID = '#E6E8EC';
export const INK_PRIMARY = '#111827';
export const INK_SECONDARY = '#4B5563';
export const INK_MUTED = '#636B78';

/**
 * Single-series magnitude. One hue, no legend — the title names the series.
 */
export const SERIES = '#1A5E58';
export const SERIES_BRIGHT = '#134742';

/**
 * The pipeline, as an ordinal ramp that darkens toward completion.
 * Monotone lightness; the light end is 3.36:1 on white.
 */
export const PIPELINE_RAMP = ['#5E9690', '#4C857F', '#33716B', '#1A5E58'];

/**
 * Terminal states. Reserved colours outside the brand palette so a status can
 * never be mistaken for a series; both are always written out in text too.
 */
export const STATUS_COLORS = {
  Inquiry: PIPELINE_RAMP[0],
  Requested: PIPELINE_RAMP[1],
  Booked: PIPELINE_RAMP[3],
  Rejected: '#B91C1C',
  Cancelled: '#6B7280',
};

/**
 * Where a booking's money has got to.
 *
 * These are not a new ramp: they are the pipeline ramp used for the one thing
 * it was validated for, progress toward a finished state, plus the two reserved
 * terminal colours the statuses already use. Nothing paid is muted ink, a
 * deposit is the mid teal, settled is the dark end.
 *
 * `Overdue` is not a payment status — it is derived from the due date every
 * time it is read — so it never appears alone. It is drawn beside the written
 * day count, which is what actually carries the meaning.
 */
export const PAYMENT_COLORS = {
  Unpaid: INK_MUTED,
  Pending: PIPELINE_RAMP[0],
  'Deposit paid': PIPELINE_RAMP[1],
  Paid: PIPELINE_RAMP[3],
  Refunded: '#6B7280',
  'Written off': '#6B7280',
};

export const OVERDUE = '#B91C1C';

/**
 * Categorical identity — courses, where the series *are* the subject.
 *
 * Capped at three on purpose, so a fourth category folds into "Other" or the
 * chart becomes a table. On white the worst normal-vision pair is ΔE 47. The
 * colourblind simulation has not been re-run for these three -- do that before
 * extending the array, and before relying on hue alone anywhere.
 */
export const CATEGORICAL = ['#2F5D7C', '#C2410C', '#8A6D1F'];
export const CATEGORICAL_CAP = CATEGORICAL.length;

/**
 * Continuous magnitude for the tee-sheet heatmap: one teal hue, monotone
 * lightness, dark meaning more. The lightest step is allowed to recede toward
 * the surface because it means "almost nothing"; an actual zero is drawn as
 * bare surface with a hairline ring, so empty and nearly-empty never look alike.
 */
export const SEQUENTIAL = ['#D6E2E1', '#A9C6C3', '#7BA9A4', '#4C857F', '#1A5E58'];

/**
 * Period-over-period cues. Red and green are hard for a deuteranope to tell
 * apart, so these only ever appear in a stat tile beside an arrow glyph and
 * the signed number — never as a mark inside a plot, and never alone.
 */
export const DELTA_UP = '#047857';
export const DELTA_DOWN = '#B91C1C';

/** Recessive chrome shared by every chart. */
export const AXIS = {
  stroke: GRID,
  tick: { fill: INK_MUTED, fontSize: 11 },
  tickLine: false,
};

export function categoricalColor(index) {
  return CATEGORICAL[index % CATEGORICAL.length];
}

/** Bucket a 0..1 intensity onto the sequential ramp; 0 stays bare surface. */
export function sequentialStep(intensity) {
  if (!intensity) return null;
  const index = Math.min(SEQUENTIAL.length - 1, Math.floor(intensity * SEQUENTIAL.length - 1e-9));
  return SEQUENTIAL[Math.max(index, 0)];
}
