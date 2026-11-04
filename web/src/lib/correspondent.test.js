import { describe, expect, test } from 'vitest';
import { correspondent, greetingFirstName, leadGuestAside } from './correspondent.js';

describe('correspondent', () => {
  test('a tour operator is named as themselves, never as the guest they booked for', () => {
    // The booking carries the lead guest's name; the email came from the
    // operator who made it. Borrowing the guest's name here is how a reply
    // ends up opening "Hi Isla," to a travel agent.
    expect(
      correspondent({
        email: 'Groups@Tours.test',
        leadGuestEmail: 'isla@example.com',
        leadGuestName: 'Isla Byrne',
      }),
    ).toEqual({
      email: 'groups@tours.test',
      name: '',
      isLeadGuest: false,
      label: 'groups@tours.test',
      firstName: '',
    });
  });

  test('the lead guest writing from their own address is called by their name', () => {
    expect(
      correspondent({
        email: 'isla@example.com',
        leadGuestEmail: 'Isla@Example.com',
        leadGuestName: 'Isla Byrne',
      }),
    ).toEqual({
      email: 'isla@example.com',
      name: 'Isla Byrne',
      isLeadGuest: true,
      label: 'Isla Byrne',
      firstName: 'Isla',
    });
  });

  test('nothing to go on is a blank rather than a guess', () => {
    expect(correspondent()).toEqual({ email: '', name: '', isLeadGuest: false, label: '', firstName: '' });
  });
});

describe('the name a reply opens with', () => {
  test('a person is greeted by their first name', () => {
    expect(greetingFirstName({ kind: 'guest', name: 'Adam Gordon' })).toBe('Adam');
    expect(greetingFirstName({ kind: 'self-named', name: 'Jo Byrne' })).toBe('Jo');
  });

  test('an agency and a shared desk are not, whatever name they are labelled with', () => {
    // The label is the agency's; a greeting is a person's.
    expect(greetingFirstName({ kind: 'operator', name: 'Halcyon Golf Travel' })).toBe('');
    expect(greetingFirstName({ kind: 'shared', name: 'Fairways and FunDays' })).toBe('');
  });

  test('a mailbox that signs itself as a department is not a person either', () => {
    // These arrive as the name on a From header, which nothing vouches for.
    expect(greetingFirstName({ kind: 'self-named', name: 'Bookings | Halcyon Golf Travel' })).toBe('');
    expect(greetingFirstName({ kind: 'self-named', name: 'Reservations' })).toBe('');
    expect(greetingFirstName({ kind: 'self-named', name: 'Info' })).toBe('');
    // A shouted name is a signature, not how somebody is addressed.
    expect(greetingFirstName({ kind: 'self-named', name: 'SWING GOLF IRELAND' })).toBe('');
  });

  test('no name, and no correspondent at all, leave the greeting plain', () => {
    expect(greetingFirstName({ kind: 'unknown', name: '' })).toBe('');
    expect(greetingFirstName(null)).toBe('');
  });
});

describe('the booking lead, as an aside', () => {
  test('is named when the round is for somebody other than whoever wrote', () => {
    const operator = { email: 'bookings@tours.test', name: 'Tours', isLeadGuest: false };
    expect(leadGuestAside({ guestName: 'Lori Corrion' }, operator)).toBe('Lori Corrion');
  });

  test('is left out when the correspondent IS the lead guest', () => {
    // One person, named once: a second line calling them "the lead guest"
    // reads as somebody else.
    const herself = { email: 'isla@example.com', name: 'Isla Byrne', isLeadGuest: true };
    expect(leadGuestAside({ guestName: 'Isla Byrne' }, herself)).toBe('');
  });

  test('is left out when the booking has no name, or only the address again', () => {
    // Older rows carry the address in the name column.
    expect(leadGuestAside({ guestName: '' })).toBe('');
    expect(leadGuestAside({ guestName: 'dave@ramaley.com', guestEmail: 'dave@ramaley.com' })).toBe('');
    expect(leadGuestAside(null)).toBe('');
  });

  test('reads the name a waitlist entry or request calls it, as well as a booking', () => {
    expect(leadGuestAside({ leadGuestName: 'Tim Whelan' })).toBe('Tim Whelan');
  });
});
