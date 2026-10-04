/**
 * The slice of the Club Vero partner API this dashboard uses: one round in,
 * one survey link out.
 *
 * A plain `fetch`, for the same reason `sendgrid.js` is one — a single POST is
 * not worth a dependency, and Node 20 has fetch built in.
 *
 * Like `sendTemplateEmail`, this resolves to an outcome rather than throwing.
 * A campaign run covers many guests, and one unreachable round must not
 * abandon the rest of the batch.
 */
const TIMEOUT_MS = 15_000;

/**
 * Ask Vero for the survey link for one round.
 *
 * Resolves to one of three shapes:
 *   { ok: true,  surveyUrl, unsubscribeUrl, created, answered }
 *   { ok: true,  suppressed: true, message }   — the guest has unsubscribed
 *   { ok: false, status, message }             — nothing was minted
 *
 * The suppressed case is deliberately a success. Nothing went wrong: the guest
 * exercised a right, and the caller needs to skip the send rather than count a
 * failure and go looking for the fault.
 */
export async function requestSurveyLink({ baseUrl, apiKey, source, round, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}/api/partner/golf-round`, {
      method: 'POST',
      headers: {
        // The credential travels in a header, never in the body: a body is
        // data, and data ends up in logs beside the guest's email address.
        'x-partner-key': apiKey,
        'x-partner-source': source,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(round),
      signal: controller.signal,
    });

    const payload = await readJson(response);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: `Club Vero refused the round (${response.status}): ${payload?.error ?? 'no reason given'}`,
      };
    }

    if (payload?.suppressed) {
      return {
        ok: true,
        suppressed: true,
        message: payload.reason || 'This guest has unsubscribed from feedback requests',
      };
    }

    if (payload?.dry_run) {
      return {
        ok: true,
        dryRun: true,
        message: `Club Vero would create a survey for ${payload.outlet ?? 'the course'}`,
      };
    }

    if (!payload?.survey_url) {
      // A 200 with nothing usable in it. Reported as a failure rather than
      // sending an email whose feedback link renders as an empty string.
      return { ok: false, status: response.status, message: 'Club Vero returned no survey link' };
    }

    return {
      ok: true,
      surveyUrl: payload.survey_url,
      unsubscribeUrl: payload.unsubscribe_url ?? null,
      created: payload.created !== false,
      answered: Boolean(payload.answered),
      message:
        payload.created === false
          ? payload.answered
            ? 'Reusing the survey this guest has already answered'
            : 'Reusing the survey already created for this booking'
          : `Survey created against ${payload.outlet ?? 'the course'}`,
    };
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'Club Vero timed out' : err.message;
    return { ok: false, status: 0, message };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
