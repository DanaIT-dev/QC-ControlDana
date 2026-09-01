import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { splitChatBody } from '@sgr-registry/domain';

afterEach(() => {
  cleanup();
});

describe('act chat body rendering', () => {
  it('keeps HTML and javascript as text nodes', () => {
    const body = '<script>alert(1)</script> @Иван Петров javascript:alert(2)';
    const segments = splitChatBody(body, [
      { userId: '33333333-3333-4333-8333-333333333333', fullName: 'Иван Петров' },
    ]);
    const { container } = render(
      <p>
        {segments.map((segment, index) =>
          segment.kind === 'mention' ? (
            <span key={index} data-mention>
              {segment.text}
            </span>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('javascript:alert(2)');
    expect(screen.getByText('@Иван Петров')).toBeInTheDocument();
  });
});
