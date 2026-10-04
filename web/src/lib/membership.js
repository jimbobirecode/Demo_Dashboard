/**
 * The membership pipeline as the page shows it: labels, colours, and what
 * each staff action does — including the email the applicant receives, which
 * the page states before anybody confirms.
 */
import { PIPELINE_RAMP, STATUS_COLORS } from './palette.js';

export const MEMBERSHIP_STATUS_LABELS = {
  enquired: 'Enquired',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  declined: 'Declined',
  welcomed: 'Welcomed',
  waitlisted: 'Waitlisted',
  invited: 'Invited to apply',
  withdrawn: 'Withdrawn',
};

/** Progress uses the gold ramp; the endings reuse the reserved terminal colours. */
export const MEMBERSHIP_STATUS_COLORS = {
  enquired: PIPELINE_RAMP[0],
  submitted: PIPELINE_RAMP[1],
  under_review: PIPELINE_RAMP[2],
  approved: PIPELINE_RAMP[3],
  welcomed: '#8FBF6A',
  declined: STATUS_COLORS.Rejected,
  withdrawn: STATUS_COLORS.Cancelled,
  waitlisted: '#6E9FC0',
  invited: '#A9C8DC',
};

/** The filters on the Applications tab, in pipeline order. */
export const APPLICATION_FILTERS = [
  { id: 'action', label: 'Needs action', statuses: ['submitted', 'under_review', 'approved'] },
  { id: 'submitted', label: 'Submitted', statuses: ['submitted'] },
  { id: 'under_review', label: 'Under review', statuses: ['under_review'] },
  { id: 'approved', label: 'Approved', statuses: ['approved'] },
  { id: 'welcomed', label: 'Welcomed', statuses: ['welcomed'] },
  { id: 'declined', label: 'Declined', statuses: ['declined'] },
  { id: 'enquired', label: 'Enquired', statuses: ['enquired', 'invited'] },
  { id: 'withdrawn', label: 'Withdrawn', statuses: ['withdrawn'] },
  { id: 'all', label: 'All', statuses: null },
];

/**
 * Each move staff can make, with the email it sends. `note` is the prompt
 * for an optional note: on a decision it goes into the applicant's email;
 * otherwise it stays on the timeline.
 */
export const MEMBERSHIP_ACTIONS = {
  under_review: {
    label: 'Start review',
    email:
      '“Your application is with the committee” — confirms their reference and chosen category, and that they will hear once the committee has decided.',
    note: 'Internal note for the timeline (optional, not emailed)',
  },
  approved: {
    label: 'Approve',
    email:
      'Approval — congratulations, their category with the joining fee and annual subscription, the amount due and your next steps.',
    note: 'A line to include in the approval email (optional)',
  },
  declined: {
    label: 'Decline',
    danger: true,
    email:
      'A courteous decline — thanks them for applying and invites them to visit; your note is included if you write one.',
    note: 'Reason or message to include in the email (optional)',
  },
  welcomed: {
    label: 'Send welcome',
    email: 'Welcome to the club — their category, fees payable, when membership starts and who to contact.',
    note: 'Internal note for the timeline (optional, not emailed)',
  },
  invited: {
    label: 'Invite to apply',
    email: 'An invitation to apply — a signed link to the full application form, under the same reference.',
  },
  withdrawn: {
    label: 'Mark withdrawn',
    danger: true,
    email: null,
    note: 'Why (optional, stays on the timeline)',
  },
};

export function statusLabel(status) {
  return MEMBERSHIP_STATUS_LABELS[status] ?? status;
}
