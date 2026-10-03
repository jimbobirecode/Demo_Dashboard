import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '../lib/format.js';

/**
 * Uploading the club's own tee sheet.
 *
 * Two steps, because the failure that matters here is silent: a sheet whose
 * 03/04 means 4 March imports perfectly and is wrong in every row. So nothing
 * is written until somebody has seen the dates it read.
 */
export default function Import({ user }) {
  const [config, setConfig] = useState(null);
  const [file, setFile] = useState(null);
  const [dayFirst, setDayFirst] = useState(true);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.importConfig().then(setConfig).catch((err) => setError(err.message));
  }, []);

  async function read(selected) {
    setFile(null);
    setPreview(null);
    setResult(null);
    if (!selected) return;

    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(selected);
    });
    setFile({ filename: selected.name, content });
  }

  async function run(action, setter) {
    setBusy(true);
    setError(null);
    try {
      setter(await action());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (config && !config.available) {
    return (
      <div className="stack">
        <h1>Upload tee sheet</h1>
        <div className="banner error">{config.reason}</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <header>
        <h1>Upload tee sheet</h1>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          Bring in bookings made in the club's own system. They are marked as imported, so they
          count as play and revenue but never as enquiries TeeMail converted.
        </p>
      </header>

      {error && <div className="banner error">{error}</div>}

      <form className="card stack" style={{ gap: '0.75rem' }} onSubmit={(event) => event.preventDefault()}>
        <div className="toolbar">
          <label className="stack grow" style={{ gap: '0.35rem' }}>
            <span className="label">CSV or Excel file</span>
            <input
              type="file"
              accept=".csv,.xlsx,.xlsm,text/csv"
              onChange={(event) => read(event.target.files?.[0])}
            />
          </label>
          <label className="stack" style={{ gap: '0.35rem' }}>
            <span className="label">Dates read as</span>
            <select
              value={dayFirst ? 'day' : 'month'}
              onChange={(event) => { setDayFirst(event.target.value === 'day'); setPreview(null); }}
              style={{ width: 'auto' }}
            >
              <option value="day">Day first — 03/04 is 3 April</option>
              <option value="month">Month first — 03/04 is 4 March</option>
            </select>
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={!file || busy}
            onClick={() => run(() => api.previewImport({ ...file, dayFirst }), setPreview)}
          >
            {busy ? 'Reading…' : 'Check the file'}
          </button>
        </div>
      </form>

      {preview && (
        <Preview
          preview={preview}
          busy={busy}
          onCommit={() =>
            run(async () => {
              const outcome = await api.commitImport({ ...file, dayFirst });
              setPreview(null);
              api.importConfig().then(setConfig).catch(() => {});
              return outcome;
            }, setResult)
          }
        />
      )}

      {result && (
        <div className="banner success">
          Imported {formatNumber(result.inserted)} booking{result.inserted === 1 ? '' : 's'} as{' '}
          <span className="mono">{result.batchId}</span>
          {result.skippedDuplicates ? ` · ${formatNumber(result.skippedDuplicates)} already here` : ''}
          {result.rejected ? ` · ${formatNumber(result.rejected)} row(s) refused` : ''}
        </div>
      )}

      {config?.batches?.length > 0 && (
        <Batches
          batches={config.batches}
          busy={busy}
          // Undoing deletes bookings in bulk, which the API keeps for
          // administrators; staff see the history without the button.
          canUndo={user?.role === 'admin'}
          onUndo={(batch) =>
            run(async () => {
              const undone = await api.undoImport(batch.batchId);
              setError(null);
              api.importConfig().then(setConfig).catch(() => {});
              return { batchId: batch.batchId, inserted: 0, message: undone.message, ...undone };
            }, setResult)
          }
        />
      )}
    </div>
  );
}

function Preview({ preview, onCommit, busy }) {
  const nothingToDo = preview.fresh === 0;

  return (
    <div className="card stack" style={{ gap: '1rem' }}>
      <div className="between">
        <div>
          <h3>What the file contains</h3>
          <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem' }}>
            Nothing has been written. Check the dates below before importing.
          </p>
        </div>
        <button type="button" className="btn-primary" disabled={busy || nothingToDo} onClick={onCommit}>
          {nothingToDo ? 'Nothing to import' : `Import ${formatNumber(preview.fresh)} booking${preview.fresh === 1 ? '' : 's'}`}
        </button>
      </div>

      <div className="detail-grid">
        <Figure label="Rows readable" value={formatNumber(preview.bookings.length)} />
        <Figure label="New" value={formatNumber(preview.fresh)} />
        <Figure label="Already here" value={formatNumber(preview.duplicates)} />
        <Figure label="Refused" value={formatNumber(preview.rejected.length)} />
      </div>

      {preview.unmapped.length > 0 && (
        <div className="banner">
          <strong>Columns not used:</strong> {preview.unmapped.join(', ')}. If one of those is the
          price or the date, rename its header and upload again.
        </div>
      )}

      <div>
        <div className="label" style={{ marginBottom: '0.35rem' }}>
          First rows, as they will be saved
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Date</th><th>Tee time</th><th className="num">Players</th>
                <th className="num">Total</th><th>Guest</th><th>Course</th>
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((row) => (
                <tr key={row.line}>
                  <td>{formatDate(row.date)}</td>
                  <td>{row.teeTime ?? 'Not specified'}</td>
                  <td className="num">{row.players}</td>
                  <td className="num">{formatCurrency(row.total)}</td>
                  <td>{row.guestName || row.guestEmail || '—'}</td>
                  <td>{row.golfCourses || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {preview.rejected.length > 0 && (
        <details className="chart-table">
          <summary className="btn-sm">Show the {preview.rejected.length} refused row(s)</summary>
          <ul className="stack" style={{ gap: '0.25rem', marginTop: '0.5rem', fontSize: '0.8125rem' }}>
            {preview.rejected.slice(0, 50).map((row) => (
              <li key={row.line} className="muted">Row {row.line}: {row.reason}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Batches({ batches, onUndo, busy, canUndo }) {
  return (
    <div className="card stack" style={{ gap: '0.75rem' }}>
      <div>
        <h3>Previous uploads</h3>
        <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem' }}>
          {canUndo
            ? 'Undoing removes the rows nobody has edited since — anything worked on is left alone.'
            : 'Only an administrator can undo an upload.'}
        </p>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Batch</th><th>Uploaded</th><th>Covering</th>
              <th className="num">Bookings</th><th />
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.batchId}>
                <td className="mono">{batch.batchId}</td>
                <td>{batch.importedAt ? formatDateTime(batch.importedAt) : '—'}</td>
                <td>
                  {batch.firstDate ? formatDate(batch.firstDate) : '—'}
                  {batch.lastDate && batch.lastDate !== batch.firstDate ? ` – ${formatDate(batch.lastDate)}` : ''}
                </td>
                <td className="num">{formatNumber(batch.bookings)}</td>
                <td className="num">
                  {canUndo && (
                  <button
                    type="button"
                    className="btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(
                        `Remove the ${batch.bookings} booking(s) from ${batch.batchId}? ` +
                        'Any that have been edited since are kept.',
                      )) onUndo(batch);
                    }}
                  >
                    Undo
                  </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Figure({ label, value }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>{value}</div>
    </div>
  );
}
