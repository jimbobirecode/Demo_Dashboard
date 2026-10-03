import {
  CATEGORICAL,
  GRID,
  INK_MUTED,
  INK_PRIMARY,
  INK_SECONDARY,
  PIPELINE_RAMP,
  SEQUENTIAL,
  SERIES,
  SERIES_BRIGHT,
  STATUS_COLORS,
  SURFACE,
  SURFACE_SUNK,
  DELTA_DOWN,
  DELTA_UP,
} from './src/lib/palette.js';

/**
 * Tailwind is here for the ported Tremor chart components only.
 *
 * `preflight` is off on purpose: this app is styled by `theme.css`, and
 * Tailwind's base reset would flatten its buttons, inputs and tables. Utilities
 * are emitted after that stylesheet so a chart can still override locally.
 *
 * The theme reads `src/lib/palette.js`, so the validated ramps and the utility
 * classes can never drift apart.
 */
export default {
  corePlugins: { preflight: false },
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: SURFACE, sunk: SURFACE_SUNK },
        hairline: GRID,
        ink: { DEFAULT: INK_PRIMARY, secondary: INK_SECONDARY, muted: INK_MUTED },
        series: { DEFAULT: SERIES, bright: SERIES_BRIGHT },
        delta: { up: DELTA_UP, down: DELTA_DOWN },
        status: Object.fromEntries(Object.entries(STATUS_COLORS).map(([name, hex]) => [name.toLowerCase(), hex])),
        pipeline: Object.fromEntries(PIPELINE_RAMP.map((hex, i) => [i + 1, hex])),
        categorical: Object.fromEntries(CATEGORICAL.map((hex, i) => [i + 1, hex])),
        sequential: Object.fromEntries(SEQUENTIAL.map((hex, i) => [i + 1, hex])),
      },
      borderRadius: { card: '10px', sm: '6px' },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Cormorant Garamond', 'Georgia', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
