import { SERIES } from '../../lib/palette.js';
import { cx } from './cx.js';

/**
 * Tremor's bar list: the label sits inside its own bar, so identity is read
 * from text rather than from colour. That is why this is the right form for
 * course mix — three categories, none of which needs a hue to be understood.
 */
export function BarList({
  data,
  index = 'key',
  category = 'count',
  color = SERIES,
  colorFor,
  valueFormatter = (value) => value,
  onSelect,
  emptyMessage = 'Nothing in this period.',
}) {
  if (!data.length) return <div className="empty">{emptyMessage}</div>;

  const peak = Math.max(...data.map((row) => Number(row[category]) || 0), 1);

  return (
    <ul className="flex flex-col gap-2">
      {data.map((row, position) => {
        const value = Number(row[category]) || 0;
        const width = Math.max((value / peak) * 100, 2);
        const fill = colorFor ? colorFor(row, position) : color;
        const Row = onSelect ? 'button' : 'div';

        return (
          <li key={row[index]} className="flex items-center gap-4">
            <div className="relative w-full">
              <Row
                type={onSelect ? 'button' : undefined}
                onClick={onSelect ? () => onSelect(row) : undefined}
                className={cx(
                  'flex h-8 w-full items-center rounded-sm border-0 bg-transparent p-0 text-left',
                  onSelect && 'cursor-pointer',
                )}
              >
                <div className="h-8 rounded-sm" style={{ width: `${width}%`, background: fill, opacity: 0.55 }} />
                <span className="absolute left-2 truncate text-[0.8125rem] font-medium text-ink">
                  {row.label ?? row[index]}
                </span>
              </Row>
            </div>
            <span className="w-16 shrink-0 text-right text-[0.8125rem] font-semibold tabular-nums text-ink">
              {valueFormatter(value)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
