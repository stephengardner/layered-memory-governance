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
});
