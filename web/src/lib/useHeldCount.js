import { useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * How many bookings the lifecycle ladder has stopped at, for the badge in the
 * sidebar.
 *
 * The badge is the point. With auto-cancel off — the default — a booking that
 * runs out of road is listed for a person and nothing is emailed, so the
 * ladder's last step depends entirely on somebody noticing. A number in the
 * sidebar is the difference between that and a list nobody opens.
 *
 * Polled every five minutes while the tab is visible, rather than the Inbox's
 * minute: these are decisions that sat for days before the ladder reached
 * them, and none of them is urgent to the minute. A failure is swallowed —
 * the ladder is usually switched off, and an error badge on a page a club
 * does not use would be noise.
 */
export function useHeldCount(enabled) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const check = () =>
      api
        .lifecycleHeld()
        .then((payload) => live && setCount(payload.held?.length ?? 0))
        .catch(() => {});
    check();
    const timer = setInterval(() => document.visibilityState === 'visible' && check(), 300_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled]);

  return [count, setCount];
}
