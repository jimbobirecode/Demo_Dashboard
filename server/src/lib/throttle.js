/**
 * A crude per-key throttle, in memory.
 *
 * It exists so one script cannot mail a user hundreds of links or work through
 * a password list, not to survive a restart or to coordinate across instances.
 * That is enough for the single Render instance this runs on; a second
 * instance would give an attacker a second budget, and a real rate limiter
 * (or a shared store) belongs in front of the app before that happens. Keys
 * are dropped as they expire, so the map does not grow without bound.
 *
 * Two ways to use it:
 *
 *  - `check(key)` counts every call — the right shape for "no more than N
 *    emails an hour", where asking is the thing being limited;
 *  - `blocked(key)` / `fail(key)` / `clear(key)` count only failures — the
 *    shape for a login, where a person who types their password correctly
 *    should never be locked out by having signed in a few times.
 */
export function createThrottle({ limit = 5, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();

  const recent = (key, now) => (hits.get(key) ?? []).filter((time) => now - time < windowMs);

  function prune(now) {
    for (const [other, times] of hits) {
      if (!times.some((time) => now - time < windowMs)) hits.delete(other);
    }
  }

  function record(key, now) {
    const times = recent(key, now);
    times.push(now);
    hits.set(key, times);
    prune(now);
    return times.length;
  }

  return {
    /** True when this key may proceed; the call itself counts as an attempt. */
    check(key, now = Date.now()) {
      return record(key, now) <= limit;
    },

    /** True when this key has used its budget. Counts nothing. */
    blocked(key, now = Date.now()) {
      return recent(key, now).length >= limit;
    },

    /** Count one failure against this key. */
    fail(key, now = Date.now()) {
      record(key, now);
    },

    /** Forget this key — a successful sign-in wipes its failures. */
    clear(key) {
      hits.delete(key);
    },

    /** Whole seconds until this key may try again; 0 when it already may. */
    retryAfterSeconds(key, now = Date.now()) {
      const times = recent(key, now);
      if (times.length < limit) return 0;
      // The oldest attempt still counting has to age out for one slot to free.
      const oldest = times[times.length - limit];
      return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    },

    reset() {
      hits.clear();
    },
  };
}
