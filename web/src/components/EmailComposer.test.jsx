import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailComposer, { composerContext } from './EmailComposer.jsx';

vi.mock('../lib/api.js', () => ({ api: { emailPreview: vi.fn() } }));

const booking = {
  bookingId: 'RD-1001',
  guestName: 'Fiona Harrington',
  guestEmail: 'fiona@example.com',
  date: '2026-07-14',
  teeTime: '09:10 AM',
  players: 4,
  total: 1720,
};

/** Fiona writing about her own round: the lead guest and the correspondent are one person. */
const fiona = {
  email: 'fiona@example.com',
  kind: 'guest',
  name: 'Fiona Harrington',
  label: 'Fiona Harrington',
  isLeadGuest: true,
};

function setup(props = {}) {
  const user = userEvent.setup();
  render(
    <EmailComposer
      to="fiona@example.com"
      context={composerContext(booking, fiona)}
      send={vi.fn()}
      draftKey="test-thread"
      {...props}
    />,
  );
  return { user, box: screen.getByRole('textbox', { name: /email to fiona@example.com/i }) };
}

describe('EmailComposer quick replies', () => {
  test('a quick reply is filled in from the booking', async () => {
    const { user, box } = setup();
    await user.click(screen.getByRole('button', { name: 'Confirm the booking' }));
    expect(box.value).toMatch(/^Hi Fiona,/);
    expect(box.value).toContain('14 Jul 2026 at 09:10 AM, 4 players');
    expect(box.value).toContain('Booking reference: RD-1001');
    // She is the lead guest and the correspondent both, which is one person:
    // the email does not go on to tell her it is "for Fiona Harrington's party".
    expect(box.value).not.toContain("Fiona Harrington's party");
  });

  test('a reply to an operator greets nobody, and names the party it is about', async () => {
    // The booking's lead guest is a client of theirs. Opening "Hi Lori," to an
    // agency's booking desk addresses somebody who is not reading it; but the
    // agency has several parties with the club, so the email has to say which.
    const operator = {
      email: 'bookings@halcyongolftravel.com',
      kind: 'operator',
      name: 'Halcyon Golf Travel',
      label: 'Halcyon Golf Travel',
      isLeadGuest: false,
    };
    const user = userEvent.setup();
    render(
      <EmailComposer
        to="bookings@halcyongolftravel.com"
        context={composerContext({ ...booking, guestName: 'Lori Corrion' }, operator)}
        send={vi.fn()}
        draftKey="operator-thread"
      />,
    );
    const box = screen.getByRole('textbox', { name: /email to bookings@halcyongolftravel.com/i });
    await user.click(screen.getByRole('button', { name: 'Confirm the booking' }));

    expect(box.value).toMatch(/^Hello,/);
    expect(box.value).not.toContain('Hi Lori');
    expect(box.value).not.toContain('Hi Halcyon');
    expect(box.value).toContain("for Lori Corrion's party");
  });

  test('switching to another reply replaces the text rather than stacking it', async () => {
    const { user, box } = setup();
    await user.click(screen.getByRole('button', { name: 'Confirm the booking' }));
    await user.click(screen.getByRole('button', { name: 'Payment reminder' }));

    expect(box.value).toContain('the balance of €1,720');
    expect(box.value).not.toContain('your tee time is confirmed');
    expect(box.value.match(/Kind regards/g)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Payment reminder' })).toHaveAttribute('aria-pressed', 'true');
    // Swapping one untouched template for another loses nothing worth putting back.
    expect(screen.queryByRole('button', { name: /put back/i })).not.toBeInTheDocument();
  });

  test('text the person wrote is kept aside and can be put back', async () => {
    const { user, box } = setup();
    await user.type(box, 'Dear Fiona, about Saturday');
    await user.click(screen.getByRole('button', { name: 'Cancellation confirmed' }));
    expect(box.value).toContain('We have cancelled your booking RD-1001');

    await user.click(screen.getByRole('button', { name: /put back what i had written/i }));
    expect(box.value).toBe('Dear Fiona, about Saturday');
  });

  test('an edited template is marked, and replacing it offers the edit back', async () => {
    const { user, box } = setup();
    await user.click(screen.getByRole('button', { name: 'Change made' }));
    await user.type(box, ' PS see you soon');
    expect(screen.getByRole('button', { name: /change made \(edited\)/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm the booking' }));
    expect(box.value).not.toContain('PS see you soon');
    await user.click(screen.getByRole('button', { name: /put back/i }));
    expect(box.value).toContain('PS see you soon');
  });

  test('send stays disabled until there is something to send', async () => {
    const { user, box } = setup();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.type(box, 'Hello');
    expect(send).toBeEnabled();
  });
});
