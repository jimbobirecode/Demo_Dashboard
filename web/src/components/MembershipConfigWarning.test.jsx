import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import MembershipConfigWarning from './MembershipConfigWarning.jsx';

const HINT =
  /If invited applicants see 'link not valid', BOOKING_LINK_SECRET differs between the dashboard and the core API – compare the LINK SECRET fingerprint in both services' startup logs\./;

describe('MembershipConfigWarning', () => {
  test('names only the link setting that is missing, and how to spot a secret mismatch', () => {
    const { container } = render(
      <MembershipConfigWarning
        settings={{ linksConfigured: false, missingLinkSettings: ['MEMBERSHIP_FORM_BASE_URL'], emailConfigured: true }}
      />,
    );
    expect(container.firstChild).toHaveClass('banner', 'error');
    expect(screen.getByText(/MEMBERSHIP_FORM_BASE_URL must be set on the server/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/BOOKING_LINK_SECRET and/);
    expect(container).toHaveTextContent(HINT);
  });

  test('with everything set it is a quiet hint, not an error', () => {
    const { container } = render(
      <MembershipConfigWarning settings={{ linksConfigured: true, missingLinkSettings: [], emailConfigured: true }} />,
    );
    expect(container.firstChild).not.toHaveClass('banner');
    expect(container).toHaveTextContent(HINT);
    expect(container).not.toHaveTextContent(/must be set/);
  });

  test('says when email is not set up', () => {
    render(<MembershipConfigWarning settings={{ linksConfigured: true, emailConfigured: false }} />);
    expect(screen.getByText(/Email sending is not set up/)).toBeInTheDocument();
  });
});
