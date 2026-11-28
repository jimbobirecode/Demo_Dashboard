import { BRAND } from '../lib/brand.js';

/**
 * The club's mark.
 *
 * A dark-on-transparent logo cannot read against the dark sidebar, so it is
 * given a light plate. Drop in artwork that already reads on dark and set
 * VITE_CLUB_LOGO_ON_DARK=true to skip the plate; with no logo at all the
 * wordmark below is used instead, which needs no artwork.
 */
export default function Wordmark({ showTagline = true }) {
  if (BRAND.logoUrl) {
    return (
      <div style={{ textAlign: 'center' }}>
        <div className={BRAND.logoOnDark ? 'logo-plate' : undefined} style={{ lineHeight: 0 }}>
          <img src={BRAND.logoUrl} alt={BRAND.name} width="168" />
        </div>
        {showTagline && (
          <div className="wordmark-sub" style={{ marginTop: '0.625rem' }}>
            {BRAND.tagline}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="wordmark">{BRAND.name}</div>
      <div className="wordmark-rule" />
      {showTagline && <div className="wordmark-sub">{BRAND.tagline}</div>}
    </div>
  );
}
