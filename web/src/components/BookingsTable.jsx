import { useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import StatusPill from './StatusPill.jsx';
import PaymentPill from './PaymentPill.jsx';
import { formatCurrency, formatDate, formatDateTime } from '../lib/format.js';
import { nextStage } from '../lib/status.js';
import { paymentRank } from '../lib/payments.js';

const columnHelper = createColumnHelper();

export default function BookingsTable({ bookings, selectedId, onSelect, onAdvance, busyId, showTrade: force }) {
  const [sorting, setSorting] = useState([{ id: 'date', desc: false }]);

  // The trade columns only earn their width once the club has operators or has
  // recorded a payment. On an install with neither, the table looks exactly as
  // it did before this feature existed.
  //
  // `showTrade` overrides that: a list already narrowed to what is owed has to
  // show the money whether or not any of it has been paid yet, and a page of
  // unpaid bookings is exactly the case the rule above reads as "no trade".
  const found = useMemo(
    () => bookings.some((booking) => booking.operatorName || (booking.payment && booking.payment.status !== 'Unpaid')),
    [bookings],
  );
  const showTrade = force ?? found;

  const columns = useMemo(
    () => [
      columnHelper.accessor('bookingId', {
        header: 'Booking',
        // The reference and the address the club writes to. The lead guest has
        // a column of its own: this cell used to read "Lori Corrion ·
        // bookings@operator.com", which looks like one person with an email
        // address and is two -- an operator's booking desk, and a guest in the
        // party who has never written to the club.
        cell: (info) => (
          <div>
            <div className="mono" style={{ fontWeight: 600 }}>
              {info.getValue()}
            </div>
            <div className="muted" style={{ fontSize: '0.75rem' }}>
              {info.row.original.guestEmail}
            </div>
          </div>
        ),
      }),
      // Whose round it is, in a column staff can sort and scan.
      //
      // It is a column rather than a line of small print because it answers a
      // question of its own: the address above says who the club corresponds
      // with, and on most of County Louth's bookings that is a tour operator,
      // so the name of the party is nowhere else on the row.
      //
      // Around a third of bookings have no name — an enquiry that never got as
      // far as naming anybody. That reads as "Not given" rather than a blank,
      // so an empty cell means the enquiry is thin, not that the column is
      // broken.
      columnHelper.accessor((row) => String(row.guestName ?? '').trim() || undefined, {
        id: 'leadGuest',
        header: 'Lead guest',
        cell: (info) => info.getValue() ?? <span className="muted">Not given</span>,
        // The unnamed sort last whichever way round, rather than filling the
        // first page either way: sortUndefined is applied before the direction,
        // so it is not flipped with everything else.
        sortUndefined: 'last',
        sortingFn: (a, b, columnId) =>
          String(a.getValue(columnId)).localeCompare(String(b.getValue(columnId)), undefined, {
            sensitivity: 'base',
          }),
      }),
      columnHelper.accessor('date', {
        header: 'Tee date',
        cell: (info) => (
          <div>
            <div>{formatDate(info.getValue())}</div>
            <div className="muted" style={{ fontSize: '0.75rem' }}>
              {info.row.original.teeTime}
            </div>
          </div>
        ),
        // Nulls sort last in both directions rather than clumping at one end.
        sortingFn: (a, b) => {
          const left = a.original.date ?? '';
          const right = b.original.date ?? '';
          if (!left) return 1;
          if (!right) return -1;
          return left.localeCompare(right);
        },
      }),
      // Beside the tee date on purpose: the gap between when a party asked and
      // when they want to play is the thing staff read these two columns for.
      columnHelper.accessor('timestamp', {
        header: 'Requested',
        cell: (info) => formatDateTime(info.getValue()),
      }),
      columnHelper.accessor('players', {
        header: 'Players',
        meta: { align: 'num' },
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor('total', {
        header: 'Total',
        meta: { align: 'num' },
        cell: (info) => formatCurrency(info.getValue()),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <>
            <StatusPill status={info.getValue()} />
            {/* Booked by a payment, and not yet on the club's tee sheet. */}
            {info.row.original.teeSheetStatus === 'to_enter' && (
              <div className="tee-sheet-flag" style={{ marginTop: '0.25rem' }}>
                Put on tee sheet
              </div>
            )}
          </>
        ),
      }),
      ...(showTrade
        ? [
            columnHelper.accessor('operatorName', {
              header: 'Account',
              cell: (info) =>
                info.getValue() ? (
                  <div>
                    <div>{info.getValue()}</div>
                    {info.row.original.operatorMatch === 'domain' && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        matched on domain
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="muted">Direct</span>
                ),
            }),
            columnHelper.accessor((row) => row.payment?.status ?? 'Unpaid', {
              id: 'paymentStatus',
              header: 'Payment',
              cell: (info) => <PaymentPill payment={info.row.original.payment} />,
              // Sorted by where the money has got to, not by the first letter
              // of the word: alphabetically "Deposit paid" comes above
              // "Unpaid", which tells nobody anything. Overdue first within a
              // status, because that is the one somebody has to ring about.
              sortingFn: (a, b) => {
                const rank = paymentRank(a.getValue('paymentStatus')) - paymentRank(b.getValue('paymentStatus'));
                if (rank !== 0) return rank;
                return (b.original.payment?.daysOverdue ?? 0) - (a.original.payment?.daysOverdue ?? 0);
              },
            }),
            columnHelper.accessor((row) => row.payment?.outstanding ?? 0, {
              id: 'outstanding',
              header: 'Outstanding',
              meta: { align: 'num' },
              cell: (info) => {
                const payment = info.row.original.payment;
                if (!(info.getValue() > 0)) return <span className="muted">—</span>;
                // Which stage the money is at, beside the figure: staff work a
                // trade booking deposit first, balance after, and the amount
                // alone does not say which of the two is being asked for.
                const stage = payment?.stages?.find((line) => line.id === payment.stage);
                return (
                  <>
                    {formatCurrency(info.getValue())}
                    {stage && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        {stage.label}
                        {stage.outstanding !== info.getValue() ? ` ${formatCurrency(stage.outstanding)}` : ''}
                      </div>
                    )}
                  </>
                );
              },
            }),
          ]
        : []),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const stage = nextStage(row.original.status);
          if (!stage) return null;
          return (
            <button
              type="button"
              className="btn-sm"
              disabled={busyId === row.original.bookingId}
              onClick={(event) => {
                event.stopPropagation();
                onAdvance(row.original, stage);
              }}
              title={`Move to ${stage}`}
            >
              → {stage}
            </button>
          );
        },
      }),
    ],
    [onAdvance, busyId, showTrade],
  );

  const table = useReactTable({
    data: bookings,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
    getRowId: (row) => row.bookingId,
  });

  if (!bookings.length) {
    return <div className="empty">No bookings match the current filters.</div>;
  }

  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortable = header.column.getCanSort();
                  const direction = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      data-sortable={sortable}
                      onClick={sortable ? header.column.getToggleSortingHandler() : undefined}
                      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
                      className={header.column.columnDef.meta?.align === 'num' ? 'num' : undefined}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {direction === 'asc' ? ' ▲' : direction === 'desc' ? ' ▼' : ''}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={row.original.bookingId === selectedId ? 'selected' : undefined}
                onClick={() => onSelect(row.original)}
                style={{ cursor: 'pointer' }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={cell.column.columnDef.meta?.align === 'num' ? 'num' : undefined}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span className="muted">
          Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount() || 1}
        </span>
        <button
          type="button"
          className="btn-sm"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        >
          Previous
        </button>
        <button type="button" className="btn-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
          Next
        </button>
        <select
          value={table.getState().pagination.pageSize}
          onChange={(event) => table.setPageSize(Number(event.target.value))}
          aria-label="Rows per page"
          style={{ width: 'auto' }}
        >
          {[25, 50, 100].map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
