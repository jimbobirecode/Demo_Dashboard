/**
 * The POST itself: one booked customer, as JSON, to the club's endpoint.
 *
 * A plain `fetch`, for the same reason `sendgrid.js` and `vero.js` are — a
 * single POST is not worth a dependency, and Node 20 has fetch built in.
 *
 * Like them, this resolves to an outcome rather than throwing. A sweep covers
 * many bookings, and one unreachable receiver must not abandon the rest of
 * the batch.
 */
const TIMEOUT_MS = 15_000;

/** Statuses worth coming back to: the receiver is down, not refusing. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Hand one booked customer to the configured endpoint.
 *
 * Resolves to one of two shapes:
 *   { ok: true,  status, message }
 *   { ok: false, status, retryable, message }
 *
 * `retryable` separates a receiver that is down from one that is refusing this
 * particular booking, which decides two things: whether the sweep abandons the
 * rest of its pass (no point timing out against a dead endpoint once per
 * booking in the backlog), and how loudly it is logged.
 *
 * Neither is ever stamped, so both are tried again on the next sweep. A
 * refusal is not given up on: most are a receiver's own bug or a validation
 * rule it has yet to relax, and the booking starts succeeding once that is
 * fixed, with nothing to replay by hand. The error in the log every pass is
 * the alert that something needs the fixing.
 */
export async function postBookedCustomer({ config, payload, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        // The credential travels in a header, never in the body: a body is
        // data, and data ends up in logs beside the guest's email address.
        [config.authHeader]: config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      // The receiver's own words, bounded: a failing endpoint that answers
      // with an HTML error page should not put a kilobyte of markup in the log
      // line, and a body is read only to explain the failure.
      const detail = (await readText(response)).slice(0, 200);
      return {
        ok: false,
        status: response.status,
        retryable: RETRYABLE.has(response.status),
        message: `${payload.bookingRef} refused (${response.status})${detail ? `: ${detail}` : ''}`,
      };
    }

    return { ok: true, status: response.status, message: `${payload.bookingRef} accepted (${response.status})` };
  } catch (err) {
    // A timeout, a DNS failure, a reset connection: the receiver was not
    // reached, so nothing was delivered and it is worth trying again.
    const message = err?.name === 'AbortError' ? `${payload.bookingRef} timed out` : err.message;
    return { ok: false, status: 0, retryable: true, message };
  } finally {
    clearTimeout(timer);
  }
}

async function readText(response) {
  try {
    return (await response.text()).trim().replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}
