/**
 * The booking pipeline as the SPA sees it.
 *
 * The colours live in `palette.js` — the one place the chart ramps are defined
 * and validated — and are re-exported here so status consumers keep importing
 * from a single module.
 */
import { INK_MUTED, STATUS_COLORS } from './palette.js';

export { STATUS_COLORS };
export const PIPELINE_STAGES = ['Inquiry', 'Requested', 'Booked'];

export const TERMINAL_STATUSES = ['Rejected', 'Cancelled'];

export const ALL_STATUSES = [...PIPELINE_STAGES, ...TERMINAL_STATUSES];

/** Nothing is hidden until the reader asks for it to be. */
export const DEFAULT_STATUS_FILTER = [...ALL_STATUSES];

const UNKNOWN_COLOR = INK_MUTED;

/**
 * Retired spellings still found in older rows: 'Pending' is the Streamlit-era
 * 'Inquiry', and 'Confirmed' was a stage that has been folded into 'Booked'.
 */
const LEGACY_STATUSES = { pending: 'Inquiry', confirmed: 'Booked' };

export function normaliseStatus(status) {
  if (!status) return PIPELINE_STAGES[0];
  const text = String(status).trim();
  if (LEGACY_STATUSES[text.toLowerCase()]) return LEGACY_STATUSES[text.toLowerCase()];
  return ALL_STATUSES.find((known) => known.toLowerCase() === text.toLowerCase()) ?? text;
}

export function statusColor(status) {
  return STATUS_COLORS[normaliseStatus(status)] ?? UNKNOWN_COLOR;
}

/** The stage a booking moves to next, or null at the end of the pipeline. */
/**
 * What a status means, for the pill it is written in: the tint behind the word.
 *
 * Separate from `statusColor`, which is the status's mark in a chart. A chart
 * needs an ordinal ramp that reads as progress; a pill sits in a table beside
 * forty others and needs to say good, bad or waiting at a glance. Booked is
 * the only good news, Rejected the only bad; Cancelled is closed, not wrong.
 */
const STATUS_TONES = {
  Inquiry: 'neutral',
  Requested: 'info',
  Booked: 'positive',
  Rejected: 'negative',
  Cancelled: 'closed',
};

export function statusTone(status) {
  return STATUS_TONES[normaliseStatus(status)] ?? 'neutral';
}

export function nextStage(status) {
  const index = PIPELINE_STAGES.indexOf(normaliseStatus(status));
  if (index === -1) return null; // rejected, cancelled, or something unknown
  return PIPELINE_STAGES[index + 1] ?? null;
}
