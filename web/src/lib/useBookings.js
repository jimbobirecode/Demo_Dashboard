import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const REFRESH_MS = 60_000;

/**
 * The club's bookings, kept current.
 *
 * A background refresh is silent: it never blanks the table or clears an edit
 * notice, and it pauses while the tab is hidden. Edits update the one changed
 * row in place rather than refetching the whole list.
 */
export function useBookings() {
  const [bookings, setBookings] = useState([]);
  // The club's trade accounts ride along with the bookings, because the drawer
  // needs the list to reassign one and a second request for a handful of names
  // is not worth its own round trip.
  const [operators, setOperators] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const mounted = useRef(true);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const payload = await api.bookings();
      if (!mounted.current) return;
      setBookings(payload.bookings);
      setOperators(payload.operators ?? []);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh({ silent: true });
    }, REFRESH_MS);

    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const replaceBooking = useCallback((updated) => {
    setBookings((current) => current.map((booking) => (booking.bookingId === updated.bookingId ? updated : booking)));
  }, []);

  const removeBooking = useCallback((bookingId) => {
    setBookings((current) => current.filter((booking) => booking.bookingId !== bookingId));
  }, []);

  return { bookings, operators, error, loading, lastUpdated, refresh, replaceBooking, removeBooking };
}
