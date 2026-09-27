import { useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * How many emails are waiting in the Inbox, for the badge in the sidebar.
 * Polled once a minute while the tab is visible; the Inbox page pushes a fresh
 * count whenever it loads, so answering an email clears the badge at once.
 */
export function useInboxCount(enabled) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const check = () =>
      api
        .inbox('open')
        .then((payload) => live && setCount(payload.counts?.open ?? 0))
        .catch(() => {});
    check();
    const timer = setInterval(() => document.visibilityState === 'visible' && check(), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled]);

  return [count, setCount];
}
