/**
 * parseBootArgs guard tests.
 *
 * Regression for CR #107 finding PRRT_kwDOSGhm9858-a17: after the
 * `--deliberate-only` -> `--execute` safety flip, unknown `--*` flags
 * silently fell through to the positional prompt slot. A typo like
 * `--excute` (missing `e`) would become the prompt, burning an LLM run
 * on nonsense input; stale docs passing `--deliberate-only` would do
 * the same and also misdirect operators who expected the old behaviour.
 *
 * The guard:
 *   - Accepts `--execute`.
 *   - Rejects `--deliberate-only` with a loud migration hint.
 *   - Rejects any other `--*` token with a clear "unknown option" error.
 *   - Leaves bare positionals alone (they are the prompt).
 *
 * parseBootArgs lives in boot-lib.ts (not boot.mjs) so the test can
 * import it directly. boot.mjs is an executable script with a shebang
 * and a top-level main() call, both of which break a vitest import;
 * keeping the parser in boot-lib mirrors how the rest of the boot
 * pipeline (loadSeedPrincipals, runDeliberation, defaultLlmClient) is
 * structured - script stays thin, logic stays testable.
 */
import { describe, expect, it } from 'vitest';

import { parseBootArgs } from '../../../src/examples/virtual-org-bootstrap/boot-lib.js';

describe('parseBootArgs', () => {
  it('accepts --execute and sets execute: true', () => {
    const result = parseBootArgs(['--execute']);
    expect(result.execute).toBe(true);
    expect(result.prompt).toBeUndefined();
  });

  it('treats bare positional as the prompt', () => {
    const result = parseBootArgs(['Hello world']);
    expect(result.execute).toBe(false);
    expect(result.prompt).toBe('Hello world');
  });

  it('accepts --execute with a positional prompt in either order', () => {
    const a = parseBootArgs(['--execute', 'Prompt text']);
    expect(a).toEqual({ execute: true, prompt: 'Prompt text' });

    const b = parseBootArgs(['Prompt text', '--execute']);
    expect(b).toEqual({ execute: true, prompt: 'Prompt text' });
  });

  it('rejects --deliberate-only with a migration hint', () => {
    expect(() => parseBootArgs(['--deliberate-only'])).toThrow(/--deliberate-only/);
    expect(() => parseBootArgs(['--deliberate-only'])).toThrow(/--execute/);
  });

  it('rejects an unknown --flag (typo like --excute) with a clear error', () => {
    expect(() => parseBootArgs(['--excute'])).toThrow(/unknown option/i);
    expect(() => parseBootArgs(['--excute'])).toThrow(/--excute/);
  });

  it('rejects an arbitrary unknown flag like --frobnitz', () => {
    expect(() => parseBootArgs(['--frobnitz'])).toThrow(/unknown option/i);
    expect(() => parseBootArgs(['--frobnitz'])).toThrow(/--frobnitz/);
  });

  it('rejects the unknown flag even when a valid prompt is also present', () => {
    // Without the guard, the unknown flag was silently demoted to a
    // second positional and the first one (prompt) still ran. Fail-fast
    // must trip regardless of positional placement.
    expect(() => parseBootArgs(['Prompt', '--typo'])).toThrow(/unknown option/i);
    expect(() => parseBootArgs(['--typo', 'Prompt'])).toThrow(/unknown option/i);
  });

  it('default (no argv) is deliberate-only with no prompt', () => {
    const result = parseBootArgs([]);
    expect(result).toEqual({ execute: false, prompt: undefined });
  });
});
