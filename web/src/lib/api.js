/**
 * The Express API, wrapped.
 *
 * Auth is a httpOnly cookie, so every call sends credentials and a 401 simply
 * means "not signed in" — `useSession` turns that into the login screen.
 * Failures throw an Error carrying the API's own message, which the pages
 * render verbatim.
 */
const BASE = '/api';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(payload?.error ?? `Request failed (${response.status})`, response.status);
  }
  return payload;
}

export const api = {
  me: () => request('/auth/me'),
  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (newPassword) =>
    request('/auth/change-password', { method: 'POST', body: { newPassword } }),

  // Password reset. All three are reachable signed out, which is the point.
  resetConfig: () => request('/auth/reset-config'),
  forgotPassword: (username) =>
    request('/auth/forgot-password', { method: 'POST', body: { username } }),
  checkResetToken: (token) =>
    request('/auth/reset-password/check', { method: 'POST', body: { token } }),
  resetPassword: (token, newPassword, confirmPassword) =>
    request('/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword, confirmPassword },
    }),

  // Account administration. Every one of these is admin-only server-side.
  usersConfig: () => request('/users/config'),
  users: () => request('/users'),
  createUser: (user) => request('/users', { method: 'POST', body: user }),
  updateUser: (id, patch) => request(`/users/${id}`, { method: 'PATCH', body: patch }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),
  inviteUser: (id) => request(`/users/${id}/invite`, { method: 'POST' }),

  // The waitlist, and the conversion report that hangs off it.
  waitlist: () => request('/waitlist'),
  addWaitlistEntry: (entry) => request('/waitlist', { method: 'POST', body: entry }),
  updateWaitlistEntry: (waitlistId, patch) =>
    request(`/waitlist/${encodeURIComponent(waitlistId)}`, { method: 'PATCH', body: patch }),
  convertWaitlistEntry: (waitlistId, booking) =>
    request(`/waitlist/${encodeURIComponent(waitlistId)}/convert`, { method: 'POST', body: booking }),
  linkWaitlistEntry: (waitlistId, bookingId) =>
    request(`/waitlist/${encodeURIComponent(waitlistId)}/link`, { method: 'POST', body: { bookingId } }),
  deleteWaitlistEntry: (waitlistId) =>
    request(`/waitlist/${encodeURIComponent(waitlistId)}`, { method: 'DELETE' }),

  // Uploading the club's own tee sheet.
  importConfig: () => request('/imports/config'),
  previewImport: (file) => request('/imports/preview', { method: 'POST', body: file }),
  commitImport: (file) => request('/imports/commit', { method: 'POST', body: file }),
  undoImport: (batchId) => request(`/imports/${encodeURIComponent(batchId)}`, { method: 'DELETE' }),

  // A guest managing their own booking. Signed out — the link is the credential.
  manageBooking: (ref, token) =>
    request(`/changes/booking${queryString({ ref, token })}`),
  requestBookingChange: (body) => request('/changes/request', { method: 'POST', body }),

  // The club's side of those requests.
  changeRequests: () => request('/changes'),
  resolveChangeRequest: (id, decision, note) =>
    request(`/changes/${id}/${decision}`, { method: 'POST', body: { note } }),

  bookings: () => request('/bookings'),
  setStatus: (bookingId, status) =>
    request(`/bookings/${encodeURIComponent(bookingId)}/status`, {
      method: 'PATCH',
      body: { status },
    }),
  setNote: (bookingId, note) =>
    request(`/bookings/${encodeURIComponent(bookingId)}/note`, {
      method: 'PATCH',
      body: { note },
    }),
  setTeeTime: (bookingId, teeTime) =>
    request(`/bookings/${encodeURIComponent(bookingId)}/tee-time`, {
      method: 'PATCH',
      body: { teeTime },
    }),
  remove: (bookingId) =>
    request(`/bookings/${encodeURIComponent(bookingId)}`, { method: 'DELETE' }),
  fixTeeTimes: () => request('/bookings/fix-tee-times', { method: 'POST' }),

  analytics: ({ from, to, granularity } = {}) =>
    request(`/analytics${queryString({ from, to, granularity })}`),

  setPayment: (bookingId, patch) =>
    request(`/bookings/${encodeURIComponent(bookingId)}/payment`, { method: 'PATCH', body: patch }),
  paymentConfig: () => request('/payments/config'),
  checkPayment: (bookingId) =>
    request(`/payments/bookings/${encodeURIComponent(bookingId)}/check`, { method: 'POST' }),
  sendReceipt: (bookingId) =>
    request(`/payments/bookings/${encodeURIComponent(bookingId)}/receipt`, { method: 'POST' }),
  sendPaymentLink: (bookingId, amount) =>
    request(`/payments/bookings/${encodeURIComponent(bookingId)}/link`, { method: 'POST', body: { amount } }),

  operators: () => request('/operators'),
  operator: (id) => request(`/operators/${id}`),
  createOperator: (operator) => request('/operators', { method: 'POST', body: operator }),
  updateOperator: (id, operator) => request(`/operators/${id}`, { method: 'PATCH', body: operator }),
  deleteOperator: (id) => request(`/operators/${id}`, { method: 'DELETE' }),
  operatorSuggestions: () => request('/operators/suggestions/unmatched'),
  assignOperator: (bookingIds, operatorId) =>
    request('/operators/assign', { method: 'POST', body: { bookingIds, operatorId } }),

  reminderConfig: () => request('/reminders/config'),
  remindersPending: (campaign, scope) =>
    request(`/reminders/pending${queryString({ campaign, scope })}`),
  sendReminders: (campaign, operatorIds, { dryRun = false, scope = 'due' } = {}) =>
    request('/reminders/send', { method: 'POST', body: { campaign, operatorIds, dryRun, scope } }),

  emailConfig: () => request('/emails/config'),
  emailPending: (campaign, scope) =>
    request(`/emails/pending${queryString({ campaign, scope })}`),
  sendCampaign: (campaign, bookingIds, { dryRun = false } = {}) =>
    request('/emails/send', { method: 'POST', body: { campaign, bookingIds, dryRun } }),
};

/**
 * Exports are plain links rather than fetches, so the browser handles the
 * download — the session cookie rides along with the navigation.
 */
export function exportUrl(format, { statuses, from, to } = {}) {
  return `${BASE}/bookings/export${queryString({
    format,
    statuses: statuses?.length ? statuses.join(',') : null,
    from,
    to,
  })}`;
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
