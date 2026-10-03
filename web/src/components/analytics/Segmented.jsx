/**
 * A small exclusive choice, the way this page switches a measure or a
 * granularity. Rendered as pressed buttons rather than a select, because the
 * options are few and the current one should be visible without opening it.
 */
export function Segmented({ label, options, value, onChange }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
