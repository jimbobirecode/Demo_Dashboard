/**
 * The tee sheet flag, the email to the team, and the booking form's payments
 * found without the webhook.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentBooked, teeSheetEmail } from '../src/lib/tee-sheet.js';
import { paidBookingFormSessions } from '../src/lib/stripe.js';

test('only a payment that books the round flags it', () => {
  assert.equal(paymentBooked('Requested', 'Booked'), true);
  assert.equal(paymentBooked('Inquiry', 'Booked'), true);
  // Confirmed by the club already: they put it on the sheet then.
  assert.equal(paymentBooked('Booked', 'Booked'), false);
  // A cancelled booking is not revived by money; a person sorts it out.
  assert.equal(paymentBooked('Cancelled', 'Cancelled'), false);
});

test('the team is told what to put on the sheet, and where to clear it', () => {
  const email = teeSheetEmail(
    {
      bookingId: 'BOOK-20261103-1A2B3C4D',
      guestName: 'Anne Kelly',
      guestEmail: 'anne.kelly@example.com',
      contactPhone: '+353 87 123 4567',
      date: '2027-06-12',
      teeTime: '09:40',
      players: 4,
      amountPaid: 1540,
    },
    { APP_URL: 'https://democlub.teemail.io/' },
  );
  assert.match(
    email.subject,
    /^Paid online — put on the tee sheet: Sat, 12 Jun 2027 at 09:40, 4 players \(BOOK-20261103-1A2B3C4D\)$/,
  );
  assert.match(email.text, /Anne Kelly has paid €1,540\.00 online, and the booking is now Booked\./);
  assert.match(email.text, /https:\/\/democlub\.teemail\.io\/bookings\?booking=BOOK-20261103-1A2B3C4D/);
  assert.match(email.html, /<a href="https:\/\/democlub\.teemail\.io\/bookings\?booking=BOOK-20261103-1A2B3C4D">/);

  // A guest's name is data, not markup.
  const hostile = teeSheetEmail(
    { bookingId: 'B', guestName: '<script>x</script>', players: 1, date: '2027-01-01' },
    {},
  );
  assert.ok(!hostile.html.includes('<script>'));
});

test("the sync asks Stripe for the form's paid checkouts, and keeps only those", async () => {
  let asked = null;
  const fetchImpl = async (url) => {
    asked = url;
    return {
      ok: true,
      json: async () => ({
        data: [
          { id: 'cs_1', payment_status: 'paid', metadata: { source: 'booking_form', booking_id: 'A' } },
          { id: 'cs_2', payment_status: 'unpaid', metadata: { source: 'booking_form', booking_id: 'B' } },
          { id: 'cs_3', payment_status: 'paid', metadata: { booking_id: 'C' } }, // a dashboard payment link
        ],
      }),
    };
  };
  const sessions = await paidBookingFormSessions({ secretKey: 'sk', since: 1_700_000_000.7, fetchImpl });
  assert.deepEqual(
    sessions.map((s) => s.id),
    ['cs_1'],
  );
  const query = new URL(asked).searchParams;
  assert.equal(query.get('status'), 'complete');
  assert.equal(query.get('created[gte]'), '1700000000');
});
