import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusPill from './StatusPill.jsx';
import { STATUS_COLORS } from '../lib/status.js';

describe('StatusPill', () => {
  test('writes the status out, so colour is never the only signal', () => {
    render(<StatusPill status="Requested" />);
    const pill = screen.getByText('Requested');
    expect(pill).toHaveClass('status-pill');
    expect(pill.style.getPropertyValue('--pill-color')).toBe(STATUS_COLORS.Requested);
  });

  test('a retired status shows the name it has today', () => {
    render(<StatusPill status="Confirmed" />);
    expect(screen.getByText('Booked')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
  });
});
