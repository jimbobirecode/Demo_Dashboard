/**
 * A heading between groups of cards.
 *
 * The analytics page is long enough that the reader needs to know which
 * question a run of cards is answering before reading any of them.
 */
export function Section({ title, blurb }) {
  return (
    <div style={{ marginTop: '0.5rem' }}>
      <h2 style={{ fontSize: '1rem', margin: 0 }}>{title}</h2>
      {blurb && (
        <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.8125rem' }}>
          {blurb}
        </p>
      )}
    </div>
  );
}

/** A labelled number, the same shape the rest of the page uses. */
export function Figure({ label, value, sub }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/**
 * What a section says when the columns behind it were never filled in: a
 * club that does not use a feature is told so rather than shown a grid of
 * zeroes.
 */
export function NotRecorded({ children }) {
  return <div className="empty">{children}</div>;
}
