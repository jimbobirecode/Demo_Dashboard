import {
  Bar,
  BarChart as RechartsBar,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AXIS, GRID, INK_SECONDARY, SERIES } from '../../lib/palette.js';
import { tooltipRenderer } from './ChartTooltip.jsx';

const HOVER_FILL = 'rgba(201, 162, 39, 0.12)';

/**
 * Magnitude by category.
 *
 * `layout="vertical"` gives horizontal bars, which is what long category names
 * want — the label sits on the axis instead of being rotated under it.
 */
export function BarChart({
  data,
  index = 'key',
  category = 'count',
  layout = 'horizontal',
  color = SERIES,
  colorFor,
  valueFormatter = (value) => value,
  labelFormatter = (value) => value,
  labelKey,
  labelRenderer,
  tooltipRows,
  height,
  barSize = 20,
  emptyMessage = 'Nothing in this period.',
}) {
  if (!data.some((row) => row[category] > 0)) return <div className="empty">{emptyMessage}</div>;

  const horizontal = layout === 'vertical';
  const resolvedHeight = height ?? (horizontal ? Math.max(180, data.length * 42) : 240);

  return (
    <ResponsiveContainer width="100%" height={resolvedHeight}>
      <RechartsBar
        data={data}
        layout={layout}
        margin={horizontal ? { top: 4, right: 56, bottom: 4, left: 8 } : { top: 12, right: 12, bottom: 4, left: 0 }}
        barCategoryGap="18%"
      >
        <CartesianGrid stroke={GRID} horizontal={!horizontal} vertical={horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tickFormatter={valueFormatter} {...AXIS} />
            <YAxis type="category" dataKey={index} width={104} {...AXIS} />
          </>
        ) : (
          <>
            <XAxis dataKey={index} interval={0} tickFormatter={labelFormatter} height={44} {...AXIS} />
            <YAxis tickFormatter={valueFormatter} width={44} {...AXIS} />
          </>
        )}
        <Tooltip
          cursor={{ fill: HOVER_FILL }}
          content={tooltipRenderer(({ payload }) => {
            const row = payload[0].payload;
            return {
              title: labelFormatter(row[index]),
              rows: tooltipRows ? tooltipRows(row) : [{ label: 'Bookings', value: valueFormatter(row[category]) }],
            };
          })}
        />
        <Bar
          dataKey={category}
          radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
          barSize={barSize}
          isAnimationActive={false}
        >
          {colorFor
            ? data.map((row, i) => <Cell key={row[index]} fill={colorFor(row, i)} />)
            : data.map((row) => <Cell key={row[index]} fill={color} />)}
          {/* Direct labels, so the value never depends on reading the axis. */}
          <LabelList
            dataKey={labelKey ?? category}
            position={horizontal ? 'right' : 'top'}
            fill={INK_SECONDARY}
            fontSize={11}
            formatter={labelRenderer ?? valueFormatter}
          />
        </Bar>
      </RechartsBar>
    </ResponsiveContainer>
  );
}
