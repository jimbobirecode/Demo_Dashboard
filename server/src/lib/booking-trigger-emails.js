/**
 * What each rung of the booking trigger workflow actually says.
 *
 * Fifteen steps is fifteen emails, and a club cannot be asked to design
 * fifteen SendGrid templates before any of the ladder works. So every step has
 * a built-in email here — branded by the same header and footer as the payment
 * link and the receipt, readable with images off — and a club that wants its
 * own design for a step sets that step's template id and this is never used for
 * it. The merge fields are the same either way, so a template written against
 * one step renders whatever the club has set for the others.
 *
 * The copy is the club's own wording from the workflow specification, written
 * out as sentences. Each step's entry says:
 *
 *   subject    a function of the merge data
 *   lead       the paragraphs before the detail table
 *   pay        whether the button is a payment link
 *   closing    the small print under the table
 *   details    which rows of the booking to show
 *   operator   the same four, in the voice for a trade account
 *
 * TWO VOICES. A visitor pays for their own round, so the chase is written to
 * the person playing: "your tee time", "your booking". A tour operator's
 * booking is paid for by the account, and every payment-phase email goes to
 * the account's contact (see `recipientFor` in the domain) -- who holds a
 * dozen of these at once, knows the terms, and does not want to be addressed
 * as if they were turning up with their clubs. So each payment step carries a
 * second version written to the trade partner: the guest named in the third
 * person, the account's own due date rather than "within N days", and the
 * terms stated as terms. The communication steps go to the guest whoever
 * pays, and have one voice.
 *
 * Pure, like `payment-link-domain.js`: no environment beyond the branding, and
 * nothing is sent from here.
 */
import { BRAND } from './brand.js';
import { cleanEmail } from './email-domain.js';
import { EMAIL_COLORS, brandTemplateData, brandedEmail, escapeHtml } from './email-layout.js';
import { manageUrlFor } from './change-request-domain.js';

const escape = escapeHtml;

/**
 * The merge fields every step carries.
 *
 * The names are the ones the existing guest templates were written against —
 * `booking_reference`, `play_date`, `course_name` — plus the figures this
 * ladder needs: what is owed, by when, and how many days are left. A template
 * for any step can use any of them.
 */
export function buildTriggerTemplateData(
  plan,
  step,
  booking,
  {
    fromEmail = null,
    money = null,
    paymentUrl = null,
    schedule = null,
    today = null,
    now = new Date(),
    operator = null,
    toEmail = null,
  } = {},
) {
  const state = money ?? plan.money;
  const entry = plan.steps.find((line) => line.step === step.id);
  const dueOn = entry?.dueOn ?? null;
  const audience = audienceFor({ plan, step, operator, toEmail: toEmail ?? entry?.to ?? null });

  return {
    ...brandTemplateData(),

    // Who, and which round.
    first_name: firstName(booking),
    guest_name: booking.guestName ?? '',
    operator_name: operator?.name ?? plan.operatorName ?? '',
    operator_contact_name: operator?.contactName ?? '',
    /** 'guest' or 'operator': whose inbox this is going to, and so which voice. */
    audience,
    /** How the email opens, in that voice. */
    salutation: salutationFor(audience, booking, operator),
    booking_reference: booking.bookingId,
    booking_id: booking.bookingId,
    play_date: formatLongDate(booking.date),
    booking_date: formatLongDate(booking.date),
    date: formatLongDate(booking.date),
    tee_time: teeTime(booking),
    course_name: course(booking),
    course: course(booking),
    player_count: String(booking.players ?? 0),
    players: String(booking.players ?? 0),

    // Which rung this is, so one template can serve several.
    step: step.id,
    step_label: step.label,
    trigger_label: step.trigger,
    flow: plan.flow,
    due_date: formatLongDate(dueOn),
    /** The day the balance falls due, which for a trade account is its own. */
    balance_due_date: formatLongDate(balanceDueOn(plan)),

    // The money, in the words the step needs it in.
    booking_total: money2(state.gross),
    total: money2(state.gross),
    amount_paid: money2(state.paid),
    amount_outstanding: money2(state.outstanding),
    outstanding_raw: state.outstanding,

    // What is being asked for TODAY, which on a trade account is not the same
    // as what is outstanding: an account holding a round on 30% owes 30% now
    // and the rest before they travel. Every chase email says this figure, and
    // it is the figure the Stripe link is made out for, so the sentence and
    // the button can never disagree. A booking with no deposit percentage --
    // every direct guest -- has one milestone, so this IS the outstanding.
    amount_due: money2(state.dueAmount ?? state.outstanding),
    due_raw: state.dueAmount ?? state.outstanding,
    deposit_amount: money2(state.depositAmount ?? 0),
    balance_amount: money2(state.balanceAmount ?? 0),
    deposit_percent: String(state.depositPercent ?? 0),
    /** 'a deposit of EUR 924 (30% of EUR 3,080)', or '' where there is no split. */
    deposit_of_total:
      state.depositAmount > 0 && state.depositPercent > 0
        ? `${money2(state.depositAmount)} (${state.depositPercent}% of ${money2(state.gross)})`
        : '',
    paid_in_full: state.settled,
    payment_url: paymentUrl ?? booking.paymentLinkUrl ?? '',

    // The deadlines, as numbers a sentence can use.
    deposit_days: String(schedule?.depositDays ?? ''),
    grace_days: String(schedule?.depositGraceDays ?? ''),
    balance_deadline_days: String(schedule?.balanceDeadlineDays ?? ''),
    days_to_play: booking.date && today ? String(Math.max(dayGap(today, booking.date), 0)) : '',

    // The lodging a stay-and-play booking carries, for the arrival emails.
    hotel_required: booking.hotelRequired ? 'Yes' : 'No',
    hotel_checkin: booking.hotelCheckin ? formatLongDate(booking.hotelCheckin) : '',
    hotel_checkout: booking.hotelCheckout ? formatLongDate(booking.hotelCheckout) : '',
    lodging_nights: String(booking.lodgingNights ?? 0),
    lodging_rooms: String(booking.lodgingRooms ?? 0),
    lodging_room_type: booking.lodgingRoomType ?? '',

    caddie_requirements: booking.caddieRequirements ?? '',
    special_requests: booking.specialRequests ?? '',

    club_name: BRAND.fullName,
    club_email: fromEmail ?? '',
    current_year: String(now.getFullYear()),
    manage_url: manageUrlFor(booking) ?? '',
  };
}

/**
 * The copy, rung by rung.
 *
 * `pay` marks the steps whose button is a payment link. A step marked `pay`
 * with no `payment_url` in its data still sends: the sentence asks them to
 * reply, because an email that says "pay using the button below" with no
 * button is worse than one that asks them to get in touch.
 */
const COPY = {
  deposit_request: {
    subject: (d) => `Secure your booking ${d.booking_reference} – ${d.club_name}`,
    pay: true,
    lead: (d) => [
      `Thank you for booking with ${d.club_name}.`,
      `To secure your tee time we ask for payment of <strong>${d.deposit_of_total || d.amount_due}</strong> within ${d.deposit_days} days of booking. Until it is received the tee time is held but not confirmed.`,
    ],
    closing: () => 'Payments are processed securely by Stripe.',
    operator: {
      subject: (d) => `Deposit to secure booking ${d.booking_reference} (${d.guest_name}) – ${d.club_name}`,
      lead: (d) => [
        `Thank you for the booking below for ${d.guest_name || 'your client'}.`,
        `Under your account terms a deposit of <strong>${d.deposit_of_total || d.amount_due}</strong> is payable by <strong>${d.due_date}</strong> to secure the tee time. Until it is received the time is held on your account but not confirmed.`,
      ],
      closing: () =>
        'Payments are processed securely by Stripe, or you may settle by bank transfer quoting the booking reference. Reply to this email if you would rather we invoiced the account.',
    },
  },

  deposit_reminder: {
    subject: (d) => `Reminder: payment due for booking ${d.booking_reference}`,
    pay: true,
    lead: (d) => [
      `We have not yet received payment for your booking with ${d.club_name}.`,
      `The tee time below is held until the ${d.deposit_days}-day window closes. If payment of <strong>${d.amount_due}</strong> has not reached us by then the booking will be cancelled and the time released.`,
    ],
    operator: {
      subject: (d) => `Reminder: deposit due ${d.due_date} for booking ${d.booking_reference} (${d.guest_name})`,
      lead: (d) => [
        `A reminder that the deposit of <strong>${d.amount_due}</strong> on the booking below for ${d.guest_name || 'your client'} is due by <strong>${d.due_date}</strong>.`,
        'The tee time is held on your account until then. If the deposit has not reached us by the due date the booking will be released under your account terms.',
      ],
      closing: () =>
        'If this has already been settled by transfer, reply with the payment reference and we will match it.',
    },
  },

  deposit_final_notice: {
    subject: (d) => `Final reminder: payment due tomorrow for booking ${d.booking_reference}`,
    pay: true,
    lead: (d) => [
      'This is a final reminder before your tee time is released.',
      `Payment of <strong>${d.amount_due}</strong> is due tomorrow. If it has not reached us the booking will be cancelled.`,
    ],
    operator: {
      subject: (d) => `Deposit due tomorrow: booking ${d.booking_reference} (${d.guest_name})`,
      lead: (d) => [
        `The deposit of <strong>${d.amount_due}</strong> on the booking below for ${d.guest_name || 'your client'} is due tomorrow, <strong>${d.due_date}</strong>.`,
        'This is the last reminder before the due date. A payment that has not reached us by then puts the booking into our release process, which we would rather avoid for both of us.',
      ],
    },
  },

  deposit_overdue: {
    subject: (d) => `Booking ${d.booking_reference} is due to be cancelled`,
    pay: true,
    lead: (d) => [
      `The ${d.deposit_days}-day window for securing your booking has now closed and we have not received payment, so the booking is marked for cancellation.`,
      `It can still be rescued. If payment of <strong>${d.amount_due}</strong> reaches us in the next ${d.grace_days} days the booking carries on exactly as it was, and you will have the confirmation by return.`,
    ],
    closing: () => 'If you no longer need the tee time you can ignore this email and it will be released.',
    operator: {
      subject: (d) => `Deposit overdue: booking ${d.booking_reference} (${d.guest_name}) is marked for release`,
      lead: (d) => [
        `The deposit on the booking below for ${d.guest_name || 'your client'} was due on ${d.due_date} and has not reached us, so the booking is now marked for release.`,
        `It can still be kept. If <strong>${d.amount_due}</strong> reaches us within the next ${d.grace_days} days the booking stands exactly as it was. After that the tee time goes back on sale.`,
      ],
      closing: () =>
        'If the group has fallen through, a reply saying so lets us release the time now rather than at the deadline — and it keeps your account in good standing.',
    },
  },

  deposit_rescue_48h: {
    subject: (d) => `48 hours to save booking ${d.booking_reference}`,
    pay: true,
    lead: (d) => [
      `Your booking is due to be cancelled in 48 hours.`,
      `Paying <strong>${d.amount_due}</strong> now keeps the tee time below. After that we release it to another party.`,
    ],
    operator: {
      subject: (d) => `48 hours: booking ${d.booking_reference} (${d.guest_name}) will be released`,
      lead: (d) => [
        `The booking below for ${d.guest_name || 'your client'} will be released in 48 hours unless the deposit of <strong>${d.amount_due}</strong> is received.`,
        'Once released the tee time is offered to other parties and we cannot guarantee to hold it again.',
      ],
    },
  },

  deposit_rescue_24h: {
    subject: (d) => `24 hours to save booking ${d.booking_reference}`,
    pay: true,
    lead: (d) => [
      `Your booking is due to be cancelled tomorrow.`,
      `This is the last chance to keep it: paying <strong>${d.amount_due}</strong> today holds the tee time below.`,
    ],
    operator: {
      subject: (d) => `Final notice: booking ${d.booking_reference} (${d.guest_name}) is released tomorrow`,
      lead: (d) => [
        `This is the final notice on the booking below for ${d.guest_name || 'your client'}: it will be released tomorrow unless the deposit of <strong>${d.amount_due}</strong> is received today.`,
        'If a payment is already on its way, reply with the reference and we will hold the time while it clears.',
      ],
    },
  },

  deposit_lapsed: {
    subject: (d) => `Booking ${d.booking_reference} has been cancelled`,
    lead: (d) => [
      `We did not receive payment for the booking below, so it has been cancelled and the tee time released.`,
      `We are sorry not to be welcoming you on this occasion. If you would still like to play at ${d.club_name}, reply to this email and we will see what we can find.`,
    ],
    operator: {
      subject: (d) => `Booking ${d.booking_reference} (${d.guest_name}) has been released`,
      lead: (d) => [
        `The deposit on the booking below for ${d.guest_name || 'your client'} was not received by the deadline, so under your account terms the booking has been cancelled and the tee time released.`,
        'Nothing is owed on it. If the group still wants to play, reply to this email and we will look at what is available — the original time may already have gone.',
      ],
    },
  },

  deposit_receipt: {
    subject: (d) => `Payment received – booking ${d.booking_reference}`,
    lead: (d) => [
      `Thank you — we have received your payment of <strong>${d.amount_paid}</strong>.`,
      d.paid_in_full
        ? 'Your booking is paid in full and confirmed.'
        : `Your booking is secured. The remaining balance of <strong>${d.amount_outstanding}</strong> falls due ${d.balance_deadline_days} days before you play, and we will be in touch before then.`,
    ],
    closing: (d) =>
      d.paid_in_full
        ? 'Please keep this email as your receipt. We will send the arrival details nearer the time.'
        : `Please keep this email as your receipt. The booking is held on our standard terms: the balance is payable no later than ${d.balance_deadline_days} days before play.`,
    operator: {
      subject: (d) => `Payment received – booking ${d.booking_reference} (${d.guest_name})`,
      lead: (d) => [
        `Thank you — we have received <strong>${d.amount_paid}</strong> against the booking below for ${d.guest_name || 'your client'}.`,
        d.paid_in_full
          ? 'The booking is paid in full and confirmed on your account.'
          : `The booking is secured. The balance of <strong>${d.amount_outstanding}</strong> is payable by <strong>${d.balance_due_date || `${d.balance_deadline_days} days before play`}</strong> under your account terms, and we will send a reminder ten days ahead of it.`,
      ],
      closing: () =>
        'Please keep this email for your records. The guest will receive the confirmation and arrival details directly from us nearer the time.',
    },
  },

  balance_notice: {
    subject: (d) => `Balance due for booking ${d.booking_reference}`,
    pay: true,
    lead: (d) => [
      `Your deposit is in and the round below is held.`,
      `Under our terms the balance of <strong>${d.amount_due}</strong> is payable ${d.balance_deadline_days} days before you play, which leaves ten days from today. This is a polite reminder rather than a demand — nothing is required of you yet beyond knowing the date.`,
    ],
    operator: {
      subject: (d) => `Balance due ${d.balance_due_date}: booking ${d.booking_reference} (${d.guest_name})`,
      lead: (d) => [
        `The deposit on the booking below for ${d.guest_name || 'your client'} is in and the round is held on your account.`,
        `Under your account terms the balance of <strong>${d.amount_due}</strong> is payable by <strong>${d.balance_due_date}</strong>. This is the ten-day notice; we will send a 48-hour and a 24-hour reminder before the date.`,
      ],
      closing: () =>
        'A payment link is below for convenience; a bank transfer quoting the booking reference is equally welcome. Reply if you would like a statement for the account.',
    },
  },

  balance_rescue_48h: {
    subject: (d) => `48 hours: balance due for booking ${d.booking_reference}`,
    pay: true,
    lead: (d) => [
      `The balance on the booking below is due in 48 hours.`,
      `<strong>${d.amount_due}</strong> remains outstanding. If it is not settled by the deadline the booking will be cancelled under our terms.`,
    ],
    operator: {
      subject: (d) => `48 hours: balance due on booking ${d.booking_reference} (${d.guest_name})`,
      lead: (d) => [
        `The balance of <strong>${d.amount_due}</strong> on the booking below for ${d.guest_name || 'your client'} is due in 48 hours, on <strong>${d.balance_due_date}</strong>.`,
        'A balance not settled by the due date puts the booking into our release process under your account terms. If a transfer is already in hand, a reply with the reference is all we need.',
      ],
    },
  },

  balance_rescue_24h: {
    subject: (d) => `24 hours: balance due for booking ${d.booking_reference}`,
    pay: true,
    lead: (d) => [
      `The balance on the booking below is due tomorrow.`,
      `<strong>${d.amount_due}</strong> remains outstanding. Settling it today keeps the round exactly as it stands.`,
    ],
    operator: {
      subject: (d) => `Final notice: balance due tomorrow on booking ${d.booking_reference} (${d.guest_name})`,
      lead: (d) => [
        `The balance of <strong>${d.amount_due}</strong> on the booking below for ${d.guest_name || 'your client'} is due tomorrow, <strong>${d.balance_due_date}</strong>.`,
        'This is the final notice before the due date. Settling it today keeps the round exactly as it stands.',
      ],
    },
  },

  balance_lapsed: {
    subject: (d) => `Booking ${d.booking_reference} has been cancelled`,
    lead: (d) => [
      `The balance on the booking below was not settled by the deadline ${d.balance_deadline_days} days before play, so under our terms the booking has been cancelled and the tee times released.`,
      'If this is not what you expected, reply to this email today and we will look at it with you.',
    ],
    operator: {
      subject: (d) => `Booking ${d.booking_reference} (${d.guest_name}) has been cancelled – balance not received`,
      lead: (d) => [
        `The balance on the booking below for ${d.guest_name || 'your client'} was not received by ${d.balance_due_date}, so under your account terms the booking has been cancelled and the tee times released.`,
        'The deposit is retained against the booking as our terms provide. If this is not what you expected — a transfer sent and not yet matched, for instance — reply today and we will look at it with you before the time is resold.',
      ],
    },
  },

  booking_confirmed: {
    subject: (d) => `Confirmed: ${d.play_date} at ${d.club_name}`,
    lead: () => [
      `Thank you — the booking below is paid in full and confirmed.`,
      'Everything is now settled, so there is nothing further to pay. From here on we will write to you about the round itself: a confirmation with the full details a month before you play, and the arrival information in the final week.',
    ],
  },

  pre_arrival_confirmation: {
    subject: (d) => `Your round at ${d.club_name} – ${d.play_date}`,
    lead: () => [
      `You are playing with us in about a month, and here is the confirmation with everything we hold.`,
      'If any of it is wrong — the number of players, the time, a caddie, a dietary requirement — the sooner we know the easier it is to put right.',
    ],
  },

  final_details: {
    subject: (d) => `Ten days to go – ${d.play_date} at ${d.club_name}`,
    lead: () => [
      `We are looking forward to welcoming you in ten days. This is the final summary of your booking.`,
      'Please arrive at least 45 minutes before your tee time to check in at the professional’s shop and warm up. Soft spikes only, and golf attire on the course and in the clubhouse.',
    ],
    closing: () => 'If anything has changed, reply to this email and we will sort it out before you travel.',
  },

  post_play: {
    subject: (d) => `Thank you for playing ${d.club_name}`,
    lead: (d) => [
      `Thank you for playing with us${d.play_date ? ` on ${d.play_date}` : ''}. We hope you enjoyed the round.`,
      'If you have a few moments we would be glad to hear how it went — what we got right, and what we did not. It is the only way we find out.',
    ],
    closing: () =>
      'We would be delighted to welcome you back. Reply to this email for our returning-visitor rates and available tee times.',
  },
};

/** Which rows of the booking each step shows under its paragraphs. */
function detailRows(stepId, data) {
  const round = [
    ['Booking reference', data.booking_reference],
    ['Date', data.play_date],
    ['Tee time', data.tee_time],
    ['Course', data.course_name],
    ['Players', data.player_count],
  ];
  const stay =
    data.hotel_required === 'Yes'
      ? [
          ['Accommodation', `${data.lodging_rooms} room(s), ${data.lodging_nights} night(s)`],
          ['Check in', data.hotel_checkin],
          ['Check out', data.hotel_checkout],
        ]
      : [];
  const asked = [
    ['Caddies', data.caddie_requirements],
    ['Requests', data.special_requests],
  ];

  // A trade partner reads a dozen of these: the guest's name and their own
  // account go at the top of the table, where the eye lands first.
  if (data.audience === 'operator') {
    round.splice(1, 0, ['Guest', data.guest_name], ['Account', data.operator_name]);
  }

  switch (stepId) {
    case 'deposit_receipt':
      return [
        ['Amount received', data.amount_paid],
        ...(data.paid_in_full ? [] : [['Balance remaining', data.amount_outstanding]]),
        ...round,
        ['Booking total', data.booking_total],
      ];
    case 'booking_confirmed':
      return [...round, ...stay, ['Booking total', data.booking_total], ['Paid', data.amount_paid]];
    case 'pre_arrival_confirmation':
    case 'final_details':
      return [...round, ...stay, ...asked];
    case 'post_play':
      return [
        ['Booking reference', data.booking_reference],
        ['Date', data.play_date],
        ['Course', data.course_name],
      ];
    case 'deposit_lapsed':
    case 'balance_lapsed':
      return round;
    default:
      // Every chase shows what is owed, and the total it is part of, so nobody
      // has to work out what is still to come.
      return [
        [stepId.startsWith('balance') ? 'Balance due' : 'Amount due', data.amount_due],
        ['Due by', data.due_date],
        ...round,
        ['Booking total', data.booking_total],
      ];
  }
}

/** Whether this step has an email of its own. Every one does; this guards a typo. */
export function hasBuiltInEmail(stepId) {
  return Object.hasOwn(COPY, stepId);
}

/**
 * The email for one step: `{ subject, text, html }`.
 *
 * `data` is what `buildTriggerTemplateData` produced, so the same values go to
 * a SendGrid template and to this.
 */
export function buildTriggerEmail(stepId, data) {
  const base = COPY[stepId];
  if (!base) throw new Error(`No email is written for the step "${stepId}"`);
  // The trade voice where the email is going to the account and the step has
  // one; the guest voice otherwise. `pay` is the step's, whichever voice.
  const copy = data.audience === 'operator' && base.operator ? { ...base, ...base.operator } : base;

  const subject = copy.subject(data);
  const lead = copy.lead(data).filter(Boolean);
  const closing = copy.closing?.(data) ?? '';
  const details = detailRows(stepId, data).filter(([, value]) => value !== '' && value != null && value !== '0');
  const greeting = data.salutation || `Hi ${data.first_name},`;

  const button = copy.pay && data.payment_url ? { href: data.payment_url, label: `Pay ${data.amount_due}` } : null;
  // A chase with no link to pay has to say what to do instead.
  const fallback =
    copy.pay && !data.payment_url ? 'Reply to this email and we will send you a secure payment link.' : '';

  const text = [
    greeting,
    '',
    ...lead.map(stripTags),
    ...(button ? ['', `Pay securely online: ${data.payment_url}`] : []),
    ...(fallback ? ['', fallback] : []),
    '',
    ...details.map(([label, value]) => `${label}: ${value}`),
    ...(closing ? ['', stripTags(closing)] : []),
    ...(data.manage_url && data.audience !== 'operator' ? ['', `Need to change or cancel? ${data.manage_url}`] : []),
    '',
    data.club_name,
  ].join('\n');

  const html = shell({
    paragraphs: [escape(greeting), ...lead],
    button,
    details,
    footer: [
      fallback && escape(fallback),
      closing && escape(closing),
      button &&
        'If the button does not work, copy this link into your browser:<br>' +
          `<a href="${escape(data.payment_url)}" style="color:${EMAIL_COLORS.accent};word-break:break-all;">${escape(data.payment_url)}</a>`,
      data.audience !== 'operator' && manageLine(data.manage_url),
    ]
      .filter(Boolean)
      .join('<br><br>'),
  });

  return { subject, text, html };
}

/**
 * The frame every step's email shares, and the one the payment link and
 * receipt already use: paragraphs, an optional button, a detail table, then the
 * small print. `paragraphs` and `footer` are HTML the caller has escaped;
 * `details` and the button are escaped here.
 */
function shell({ paragraphs, button = null, details = [], footer = '' }) {
  const c = EMAIL_COLORS;
  const rows = details
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:${c.muted};">${escape(label)}</td>` +
        `<td style="padding:6px 0;text-align:right;font-weight:600;color:${c.text};">${escape(value)}</td></tr>`,
    )
    .join('');

  const content =
    paragraphs.map((p, i) => `<p style="margin:0 0 ${i === paragraphs.length - 1 ? 20 : 12}px;">${p}</p>`).join('\n') +
    (button
      ? `<div style="text-align:center;padding:4px 0 24px;"><a href="${escape(button.href)}" style="display:inline-block;background:${c.primary};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:6px;">${escape(button.label)}</a></div>`
      : '') +
    (rows
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${c.rule};font-size:14px;">${rows}</table>`
      : '') +
    (footer ? `<div style="padding-top:16px;font-size:13px;line-height:1.6;color:${c.muted};">${footer}</div>` : '');

  return brandedEmail(content);
}

function manageLine(url) {
  return url
    ? `Need to change or cancel? <a href="${escape(url)}" style="color:${EMAIL_COLORS.accent};font-weight:600;">Manage your booking</a>.`
    : '';
}

/** The paragraphs carry <strong> for the figures; the plain-text part does not. */
function stripTags(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whose inbox this is going to.
 *
 * 'operator' only when the booking has a trade account, the step is one the
 * account pays for, and the address the run chose is the account's -- an
 * account with no contact email falls back to the guest, and the guest must
 * not then be addressed as the account.
 */
function audienceFor({ plan, step, operator, toEmail }) {
  if (!operator || step.group !== 'payment') return 'guest';
  const contact = cleanEmail(operator.contactEmail) || cleanEmail(plan.contactEmail);
  if (!contact) return 'guest';
  if (toEmail && cleanEmail(toEmail) !== contact) return 'guest';
  return 'operator';
}

function salutationFor(audience, booking, operator) {
  if (audience === 'operator') {
    const contact = String(operator?.contactName ?? '').trim();
    if (contact) return `Dear ${contact.split(/\s+/)[0]},`;
    const account = String(operator?.name ?? '').trim();
    return account ? `Dear ${account},` : 'Dear accounts team,';
  }
  return `Hi ${firstName(booking)},`;
}

/** The day the balance falls due, read off the plan so an account's own terms are honoured. */
function balanceDueOn(plan) {
  return (
    plan.steps.find((entry) => entry.step === 'balance_lapsed')?.dueOn ??
    plan.steps.find((entry) => entry.step === 'booking_confirmed')?.dueOn ??
    null
  );
}

function firstName(booking) {
  const name = String(booking.guestName ?? '').trim();
  if (name) return name.split(/\s+/)[0];
  return 'there';
}

function teeTime(booking) {
  const value = booking.teeTime;
  return value && value !== 'Not Specified' ? value : 'TBD';
}

function course(booking) {
  return booking.golfCourses?.trim() || BRAND.defaultCourse;
}

const LONG_DATE_PARTS = new Intl.DateTimeFormat(BRAND.locale, {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** 'Wednesday 18 March 2026' — assembled to match the other guest emails exactly. */
function formatLongDate(isoDate) {
  if (!isoDate) return '';
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(isoDate);
  const parts = Object.fromEntries(LONG_DATE_PARTS.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`;
}

function money2(value) {
  const amount = Number(value);
  return new Intl.NumberFormat(BRAND.locale, { style: 'currency', currency: BRAND.currency }).format(
    Number.isFinite(amount) ? amount : 0,
  );
}

function dayGap(from, to) {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}
