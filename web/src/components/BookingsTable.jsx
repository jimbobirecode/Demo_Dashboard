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
import { BRAND } from '../lib/brand.js';

const columnHelper = createColumnHelper();

export default function BookingsTable({ bookings, selectedId, onSelect, onAdvance, busyId }) {
  const [sorting, setSorting] = useState([{ id: 'date', desc: false }]);

  // The trade columns only earn their width once the club has operators or has
  // recorded a payment. On an install with neither, the table looks exactly as
  // it did before this feature existed.
  const showTrade = useMemo(
    () => bookings.some((booking) => booking.operatorName || (booking.payment && booking.payment.status !== 'Unpaid')),
    [bookings],
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor('bookingId', {
        header: 'Booking',
        cell: (info) => (
          <div>
            <div className="mono" style={{ fontWeight: 600 }}>
              {info.getValue()}
            </div>
            <div className="muted" style={{ fontSize: '0.75rem' }}>
              {info.row.original.guestName
                ? `${info.row.original.guestName} · ${info.row.original.guestEmail}`
                : info.row.original.guestEmail}
            </div>
          </div>
        ),
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
        cell: (info) => <StatusPill status={info.getValue()} />,
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
            }),
            columnHelper.accessor((row) => row.payment?.outstanding ?? 0, {
              id: 'outstanding',
              header: 'Outstanding',
              meta: { align: 'num' },
              cell: (info) =>
                info.getValue() > 0 ? formatCurrency(info.getValue()) : <span className="muted">—</span>,
            }),
          ]
        : []),
      columnHelper.accessor('hotelRequired', {
        header: BRAND.lodgingLabel,
        cell: (info) => (info.getValue() ? 'Required' : '—'),
      }),
      columnHelper.accessor('timestamp', {
        header: 'Requested',
        cell: (info) => formatDateTime(info.getValue()),
      }),
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
