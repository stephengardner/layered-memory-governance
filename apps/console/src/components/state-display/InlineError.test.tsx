import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineError } from './InlineError';

/*
 * Environment-agnostic render test.
 *
 * The unit suite runs under `environment: 'node'` (vitest.config.ts);
 * adding jsdom + a DOM testing harness for one tiny component would
 * cost more in CI install-time and config drift than it saves. The
 * InlineError surface is small enough that a server-side static
 * render captures every assertion this PR cares about: the right
 * tag, role, aria-live, the prefix, the message, the testId. The
 * Playwright spec under tests/e2e/ covers the live DOM path.
 */

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(ui);
}

describe('InlineError', () => {
  it('renders the message with the canonical "Failed to load:" prefix', () => {
    const html = render(<InlineError message="boom" />);
    expect(html).toContain('Failed to load:');
    expect(html).toContain('boom');
  });

  it('escapes the message via React (no raw HTML injection)', () => {
    /*
     * Belt-and-suspenders for a sub-block error message that contains
     * a fragment that could read as HTML (a stack-trace's `<anonymous>`
     * frame is a real example). React already escapes children, but
     * pinning the contract here means a future refactor that swaps
     * the <code> for dangerouslySetInnerHTML would fail this test
     * loudly rather than silently.
     */
    const html = render(<InlineError message="<script>x</script>" />);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('exposes role="status" and aria-live="polite" (quieter than role="alert")', () => {
    /*
     * role="status" + aria-live="polite" is the deliberate choice: a
     * sub-block hint must NOT interrupt screen readers as if the page
     * itself failed (that would be role="alert" + aria-live="assertive"
     * and is reserved for top-level ErrorState). The polite live
     * region announces the failure on the next idle pause without
     * pre-empting the operator's current focus.
     */
    const html = render(<InlineError message="x" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-live="assertive"');
  });

  it('hides the icon from assistive tech (decorative only)', () => {
    /*
     * The "Failed to load:" prefix already conveys the semantic, so
     * the AlertCircle icon is decorative. aria-hidden=true keeps
     * screen readers from announcing "warning warning warning" before
     * the actual message.
     */
    const html = render(<InlineError message="x" />);
    expect(html).toContain('aria-hidden="true"');
  });

  it('threads the optional testId onto data-testid for callers that need it', () => {
    const html = render(<InlineError message="x" testId="canon-card-references-error" />);
    expect(html).toContain('data-testid="canon-card-references-error"');
  });

  it('omits data-testid when testId is not provided', () => {
    /*
     * The component must not emit a literal `data-testid="undefined"`
     * when the prop is omitted -- that would pollute snapshot diffs
     * and create false matches for selector queries.
     */
    const html = render(<InlineError message="x" />);
    expect(html).not.toContain('data-testid');
  });

  it('renders an empty-string message without crashing', () => {
    /*
     * `toErrorMessage(new Error(''))` returns the empty string per
     * its own contract. The component must render the structural
     * shape (prefix + empty detail) without throwing or coalescing
     * to "undefined".
     */
    const html = render(<InlineError message="" />);
    expect(html).toContain('Failed to load:');
    expect(html).not.toContain('undefined');
  });
});
