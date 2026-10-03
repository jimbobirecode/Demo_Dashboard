import { Area, AreaChart as RechartsArea, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS, GRID, SERIES, SERIES_BRIGHT, SURFACE } from '../../lib/palette.js';
import { tooltipRenderer } from './ChartTooltip.jsx';

/**
 * Trend over time, one series.
 *
 * Deliberately single-measure: bookings and revenue live on scales that share
 * no axis, so the page offers a measure toggle rather than a second y-axis.
 */
export function AreaChart({
  data,
  index = 'date',
  category = 'count',
  color = SERIES,
  valueFormatter = (value) => value,
  labelFormatter = (value) => value,
  tooltipRows,
  height = 260,
  emptyMessage = 'Nothing in this period.',
}) {
  if (!data.length) return <div className="empty">{emptyMessage}</div>;

  const gradientId = `area-${category}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsArea data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={index} tickFormatter={labelFormatter} minTickGap={28} {...AXIS} />
        <YAxis tickFormatter={valueFormatter} width={52} {...AXIS} />
        <Tooltip
          cursor={{ stroke: SERIES_BRIGHT, strokeWidth: 1 }}
          content={tooltipRenderer(({ payload, label }) => ({
            title: labelFormatter(label),
            rows: tooltipRows
              ? tooltipRows(payload[0].payload)
              : [{ label: category, value: valueFormatter(payload[0].value), color }],
          }))}
        />
        <Area
          type="monotone"
          dataKey={category}
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </RechartsArea>
    </ResponsiveContainer>
  );
}
