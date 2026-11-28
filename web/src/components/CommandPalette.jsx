/**
 * The command palette: Ctrl/⌘ K from anywhere, type, Enter.
 *
 * It answers the two things somebody at the golf desk reaches for while a
 * guest is on the phone: "take me to that page" and "find that booking" — by
 * reference, by name, by the address they wrote from, or by the operator.
 *
 * Bookings are fetched when the palette first opens, not when the dashboard
 * loads, and again each time it is opened after that: the list changes while
 * the dashboard is open, and a palette that cannot find the booking taken five
 * minutes ago is worse than none. The pages work at once, before the fetch
 * returns and if it fails.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { normaliseStatus } from '../lib/status.js';
import Icon from './Icon.jsx';

/** How many bookings a search shows. More than a screenful is not a search. */
export const MAX_BOOKING_RESULTS = 8;

const FIELDS = ['bookingId', 'guestName', 'guestEmail', 'operatorName', 'contactPhone'];

/**
 * What a query matches, in the order it is shown: pages first, then bookings.
 *
 * Every word of the query has to appear somewhere in the item, in any order,
 * so "smith june" narrows rather than widens. A reference that starts with the
 * query sorts above one that merely contains it — typing the first characters
 * of a reference is the common case, and it should be the first result.
 */
export function searchCommands(query, { pages = [], bookings = [] } = {}) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const pageResults = pages
    .filter((page) => words.every((word) => page.label.toLowerCase().includes(word)))
    .map((page) => ({ kind: 'page', id: `page:${page.to}`, ...page }));

  // No query: the pages are a menu. Listing every booking under them is not.
  if (!words.length) return pageResults;

  const needle = words.join(' ');
  const bookingResults = bookings
    .map((booking) => {
      const haystack = FIELDS.map((field) => String(booking[field] ?? '').toLowerCase()).join(' \n ');
      if (!words.every((word) => haystack.includes(word))) return null;
      const reference = String(booking.bookingId ?? '').toLowerCase();
      const rank = reference === needle ? 0 : reference.startsWith(needle) ? 1 : 2;
      return { rank, booking };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_BOOKING_RESULTS)
    .map(({ booking }) => ({
      kind: 'booking',
      id: `booking:${booking.bookingId}`,
      to: `/bookings?booking=${encodeURIComponent(booking.bookingId)}`,
      label: booking.bookingId,
      detail: [booking.guestName, booking.operatorName, booking.guestEmail].filter(Boolean).join(' · '),
      status: normaliseStatus(booking.status),
    }));

  return [...pageResults, ...bookingResults];
}

export default function CommandPalette({ open, onClose, pages }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [bookings, setBookings] = useState([]);
  const [state, setState] = useState('idle'); // idle | loading | ready | failed
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setActive(0);
    let cancelled = false;
    setState('loading');
    api
      .bookings()
      .then((payload) => {
        if (cancelled) return;
        setBookings(payload?.bookings ?? []);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    // After the dialog has painted, so the input exists to be focused.
    const focus = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      cancelled = true;
      clearTimeout(focus);
    };
  }, [open]);

  const results = useMemo(() => searchCommands(query, { pages, bookings }), [query, pages, bookings]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  function go(result) {
    if (!result) return;
    onClose();
    navigate(result.to);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (results.length ? (index + 1) % results.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (results.length ? (index - 1 + results.length) % results.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(results[active]);
    }
  }

  const searching = query.trim().length > 0;
  const firstBooking = results.findIndex((result) => result.kind === 'booking');

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[active] ? `palette-${active}` : undefined}
            aria-label="Search bookings and pages"
            placeholder="Search bookings by reference, guest or operator — or jump to a page"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
          <kbd>Esc</kbd>
        </div>

        <ul id="palette-results" className="palette-results" role="listbox" ref={listRef}>
          {results.map((result, index) => (
            <li key={result.id} role="presentation">
              {index === 0 && result.kind === 'page' && <div className="palette-heading">Pages</div>}
              {index === firstBooking && <div className="palette-heading">Bookings</div>}
              <div
                id={`palette-${index}`}
                role="option"
                aria-selected={index === active}
                className="palette-item"
                onMouseEnter={() => setActive(index)}
                onClick={() => go(result)}
              >
                <span className="palette-icon">
                  <Icon name={result.kind === 'page' ? result.icon : 'bookings'} />
                </span>
                <span className="palette-text">
                  <span className={result.kind === 'booking' ? 'mono' : undefined}>{result.label}</span>
                  {result.detail && <span className="palette-detail">{result.detail}</span>}
                </span>
                {result.status && <span className="palette-status">{result.status}</span>}
              </div>
            </li>
          ))}
        </ul>

        {!results.length && (
          <div className="palette-empty">
            {state === 'loading' ? 'Looking through the bookings…' : `Nothing matches “${query.trim()}”.`}
          </div>
        )}
        {searching && state === 'failed' && (
          <div className="palette-note">The bookings could not be loaded, so only pages are searched.</div>
        )}

        <div className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}
