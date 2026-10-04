import { DATE_PRESETS } from '../lib/dateRanges.js';

/** Filters live in one row above the data, per the interaction spec. */
export default function FilterBar({ search, onSearch, preset, onPreset, custom, onCustom, onReset }) {
  // Status filtering lives on the tiles above, not here.
  return (
    <div className="toolbar">
      <div className="grow">
        <label className="sr-only" htmlFor="booking-search">
          Search bookings
        </label>
        <input
          id="booking-search"
          type="search"
          placeholder="Search by booking ID, email, course…"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>

      <select
        value={preset}
        onChange={(event) => onPreset(event.target.value)}
        aria-label="Date range"
        style={{ width: 'auto' }}
      >
        {DATE_PRESETS.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>

      {preset === 'custom' && (
        <>
          <input
            type="date"
            value={custom.from ?? ''}
            onChange={(event) => onCustom({ ...custom, from: event.target.value })}
            aria-label="From date"
            style={{ width: 'auto' }}
          />
          <input
            type="date"
            value={custom.to ?? ''}
            onChange={(event) => onCustom({ ...custom, to: event.target.value })}
            aria-label="To date"
            style={{ width: 'auto' }}
          />
        </>
      )}

      <button type="button" onClick={onReset}>
        Reset
      </button>
    </div>
  );
}
