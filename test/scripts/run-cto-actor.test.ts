/**
 * Tests for scripts/lib/run-cto-actor.mjs.
 *
 * Pure-helper tests covering parseRunCtoActorArgs: the run-cto-actor
 * driver gains a --mode <single-pass|substrate-deep> flag for the
 * deep planning pipeline. Default mode is single-pass per the
 * indie-floor canon; substrate-deep is opt-in and routes through the
 * planning-pipeline runner.
 *
 * Lives in scripts/lib/ (no shebang) so vitest+esbuild on Windows-CI
 * can import it from .test.ts. Same pattern as the other lib helpers.
 */

import { describe, expect, it } from 'vitest';
import { parseRunCtoActorArgs } from '../../scripts/lib/run-cto-actor.mjs';

describe('parseRunCtoActorArgs', () => {
  it('parses required --request', () => {
    const r = parseRunCtoActorArgs(['--request', 'ship the auditor role']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.request).toBe('ship the auditor role');
    expect(r.args.mode).toBe('single-pass');
  });

  it('rejects missing --request', () => {
    const r = parseRunCtoActorArgs([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/--request/);
  });

  it('defaults mode to single-pass (indie floor)', () => {
    const r = parseRunCtoActorArgs(['--request', 'x']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.mode).toBe('single-pass');
  });

  it('accepts --mode substrate-deep', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--mode', 'substrate-deep']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.mode).toBe('substrate-deep');
  });

  it('accepts --mode single-pass explicitly', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--mode', 'single-pass']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.mode).toBe('single-pass');
  });

  it('rejects unknown --mode value', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--mode', 'turbo']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/--mode/);
  });

  it('rejects --mode without value', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--mode']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/--mode/);
  });

  it('preserves prior flags (--stub) alongside --mode', () => {
    const r = parseRunCtoActorArgs([
      '--request', 'x',
      '--stub',
      '--mode', 'substrate-deep',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.stub).toBe(true);
      expect(r.args.mode).toBe('substrate-deep');
    }
  });

  it('preserves prior flags (--intent-id, --delegate-to) alongside --mode', () => {
    const r = parseRunCtoActorArgs([
      '--request', 'x',
      '--intent-id', 'intent-abc',
      '--delegate-to', 'code-author',
      '--mode', 'substrate-deep',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.intentId).toBe('intent-abc');
      expect(r.args.delegateTo).toBe('code-author');
      expect(r.args.mode).toBe('substrate-deep');
    }
  });

  it('preserves --max-iterations, --principal, --origin', () => {
    const r = parseRunCtoActorArgs([
      '--request', 'x',
      '--max-iterations', '3',
      '--principal', 'cto-actor',
      '--origin', 'operator',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.maxIterations).toBe(3);
      expect(r.args.principalId).toBe('cto-actor');
      expect(r.args.origin).toBe('operator');
    }
  });

  it('rejects unknown long-form flag', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--turbo']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown/i);
  });

  // GNU-style --key=value form. Keep parity with --key value: the
  // operator types either form interchangeably from shell history,
  // make scripts, and CI yaml. A parser that rejects the =-form is a
  // cosmetic friction point that surfaced when the deep-planning
  // pipeline e2e test ran `--mode=substrate-deep`.
  it('accepts --mode=substrate-deep (=-form)', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--mode=substrate-deep']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.mode).toBe('substrate-deep');
  });

  it('accepts --mode=single-pass (=-form)', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--mode=single-pass']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.mode).toBe('single-pass');
  });

  it('rejects unknown =-form value', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--mode=turbo']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/--mode/);
  });

  it('accepts --request="..." (=-form on string flag)', () => {
    const r = parseRunCtoActorArgs(['--request=ship the auditor role']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.request).toBe('ship the auditor role');
  });

  it('accepts --max-iterations=3 (=-form on numeric flag)', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--max-iterations=3']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.maxIterations).toBe(3);
  });

  it('rejects =-form numeric flag with non-numeric value', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--max-iterations=abc']);
    expect(r.ok).toBe(false);
  });

  it('accepts --intent-id=... (=-form on string flag)', () => {
    const r = parseRunCtoActorArgs([
      '--request', 'x',
      '--intent-id=intent-abc',
      '--mode=substrate-deep',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.intentId).toBe('intent-abc');
      expect(r.args.mode).toBe('substrate-deep');
    }
  });

  it('rejects =-form on a boolean flag (--dry-run=true is not standard)', () => {
    // --dry-run is a boolean toggle; an =-suffix is malformed under
    // GNU-style conventions for boolean flags. Keep the parser strict
    // here so a typo like --dry-run=ok does not silently get accepted.
    const r = parseRunCtoActorArgs(['--request', 'x', '--dry-run=true']);
    expect(r.ok).toBe(false);
  });

  // BOOL_FLAGS parity: --stub and --help must behave identically to
  // --dry-run for the =-form rejection (CR PR #244 #4195194861 nit).
  it('rejects =-form on --stub', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--stub=true']);
    expect(r.ok).toBe(false);
  });

  it('rejects =-form on --help', () => {
    const r = parseRunCtoActorArgs(['--request', 'x', '--help=true']);
    expect(r.ok).toBe(false);
  });

  // CR PR #244 #3159516688: trim trailing whitespace on --delegate-to
  // before persistence so a quoted shell argv like "code-author " does
  // not misroute identity matching.
  it('trims --delegate-to value before persistence (space-form)', () => {
    const r = parseRunCtoActorArgs([
      '--request', 'x',
      '--delegate-to', 'code-author  ',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.delegateTo).toBe('code-author');
  });

  it('trims --delegate-to value before persistence (=-form)', () => {
    const r = parseRunCtoActorArgs([
      '--request', 'x',
      '--delegate-to=  code-author',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.delegateTo).toBe('code-author');
  });

  it('rejects --delegate-to whose entire value is whitespace', () => {
    const r = parseRunCtoActorArgs([
      '--request', 'x',
      '--delegate-to', '   ',
    ]);
    expect(r.ok).toBe(false);
  });
});
