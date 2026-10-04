const LINK_SECRET_HINT =
  "If invited applicants see 'link not valid', BOOKING_LINK_SECRET differs between the dashboard and the core API – compare the LINK SECRET fingerprint in both services' startup logs.";

/**
 * What the server is missing for links and email, and, because a link can be
 * made yet still be refused by the core API, how to tell a secret mismatch.
 */
export default function MembershipConfigWarning({ settings }) {
  const missing = settings.missingLinkSettings?.length
    ? settings.missingLinkSettings
    : ['BOOKING_LINK_SECRET', 'MEMBERSHIP_FORM_BASE_URL'];
  const problems = !settings.linksConfigured || !settings.emailConfigured;
  return (
    <div className={problems ? 'banner error' : 'muted'} style={problems ? undefined : { fontSize: '0.8125rem' }}>
      {!settings.linksConfigured &&
        `Application links cannot be made yet: ${missing.join(' and ')} must be set on the server. `}
      {!settings.emailConfigured &&
        'Email sending is not set up, so decisions are recorded but applicants are not emailed. '}
      {LINK_SECRET_HINT}
    </div>
  );
}
