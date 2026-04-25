/**
 * Unit tests for scripts/cr-precheck.mjs pure helpers.
 *
 * The helper composes a detection step + a parser + an exit-code
 * decision. Each is pure (no fs / network / process side-effects) so
 * unit tests cover them directly. The full main() orchestration with
 * spawn + atom-write side effects is exercised at the validation
 * task in the plan via real CR CLI invocation.
 *
 * Output-shape note: CR CLI v0.4.2 `--agent` mode emits NDJSON. Each
 * line is a JSON object with `type` discriminator: `review_context`,
 * `status`, `finding`, `complete`, or `error`. Only `finding` lines
 * carry a `severity` (one of `critical`, `major`, `minor` per CR's
 * taxonomy; the parser tolerates additional severities by surfacing
 * them as `minor` to keep the gate calibration conservative).
 */
import { describe, expect, it } from 'vitest';
import {
  decideExitCode,
  findCoderabbitOnPath,
  isCliErrorResult,
  parseCrCliAgentFindings,
} from '../../scripts/cr-precheck.mjs';

describe('findCoderabbitOnPath', () => {
  it('returns a string path when stub finds the binary', () => {
    const stub = (name: string) => (name === 'coderabbit' ? '/usr/local/bin/coderabbit' : null);
    expect(findCoderabbitOnPath({ which: stub })).toBe('/usr/local/bin/coderabbit');
  });

  it('returns null when the stub finds neither name', () => {
    const stub = (_name: string) => null;
    expect(findCoderabbitOnPath({ which: stub })).toBe(null);
  });

  it('prefers `coderabbit` over the `cr` fallback', () => {
    // Both present: the canonical name wins so we don't accidentally
    // pick up an unrelated `cr` alias on the operator's PATH (e.g.,
    // crystal lang's REPL or a personal alias).
    const stub = (name: string) => {
      if (name === 'coderabbit') return '/opt/cr/bin/coderabbit';
      if (name === 'cr') return '/somewhere/else/cr';
      return null;
    };
    expect(findCoderabbitOnPath({ which: stub })).toBe('/opt/cr/bin/coderabbit');
  });

  it('falls back to `cr` when only the short name is present', () => {
    const stub = (name: string) => (name === 'cr' ? '/usr/bin/cr' : null);
    expect(findCoderabbitOnPath({ which: stub })).toBe('/usr/bin/cr');
  });
});

describe('parseCrCliAgentFindings', () => {
  it('returns zero counts on an empty string', () => {
    expect(parseCrCliAgentFindings('')).toEqual({ critical: 0, major: 0, minor: 0 });
  });

  it('returns zero counts on a clean review (only context + status + complete lines)', () => {
    const ndjson = [
      '{"type":"review_context","reviewType":"all","currentBranch":"feat/x","baseBranch":"main","workingDirectory":"/tmp/r"}',
      '{"type":"status","phase":"connecting","status":"connecting_to_review_service"}',
      '{"type":"status","phase":"analyzing","status":"reviewing"}',
      '{"type":"complete","status":"review_completed","findings":0}',
    ].join('\n');
    expect(parseCrCliAgentFindings(ndjson)).toEqual({ critical: 0, major: 0, minor: 0 });
  });

  it('counts mixed severities from finding lines', () => {
    // Pin the actual probe shape captured from CR CLI v0.4.2:
    // 4 findings, 3 critical + 1 major. The probe diff (auth.js with
    // hardcoded API key + eval + SQL injection) reproduces this in
    // seconds; documented here so a regression in the parser surfaces
    // as a readable failure rather than a numeric drift.
    const ndjson = [
      '{"type":"review_context"}',
      '{"type":"finding","severity":"critical","fileName":"auth.js","codegenInstructions":"..."}',
      '{"type":"finding","severity":"major","fileName":"auth.js","codegenInstructions":"..."}',
      '{"type":"finding","severity":"critical","fileName":"auth.js","codegenInstructions":"..."}',
      '{"type":"finding","severity":"critical","fileName":"auth.js","codegenInstructions":"..."}',
      '{"type":"complete","status":"review_completed","findings":4}',
    ].join('\n');
    expect(parseCrCliAgentFindings(ndjson)).toEqual({ critical: 3, major: 1, minor: 0 });
  });

  it('counts a minor finding under the minor bucket', () => {
    const ndjson = '{"type":"finding","severity":"minor","fileName":"x.js"}';
    expect(parseCrCliAgentFindings(ndjson)).toEqual({ critical: 0, major: 0, minor: 1 });
  });

  it('treats unknown severities as minor (conservative; never escalates a label we do not recognize)', () => {
    // CR's taxonomy may grow. An unrecognized severity must NOT silently
    // pass nor accidentally count as critical; surface as minor so
    // --strict still catches it without blocking by default.
    const ndjson = '{"type":"finding","severity":"trivial","fileName":"x.js"}';
    expect(parseCrCliAgentFindings(ndjson)).toEqual({ critical: 0, major: 0, minor: 1 });
  });

  it('skips malformed lines without throwing', () => {
    // CR CLI may emit a non-JSON banner or warning before / after the
    // NDJSON stream. The parser tolerates that rather than failing
    // closed (which would treat a noisy CR run as a clean review).
    const ndjson = [
      '[banner] some non-json prefix',
      '{"type":"finding","severity":"major","fileName":"x.js"}',
      '',
      'oops not json',
      '{"type":"complete","findings":1}',
    ].join('\n');
    expect(parseCrCliAgentFindings(ndjson)).toEqual({ critical: 0, major: 1, minor: 0 });
  });

  it('ignores non-finding line types (status, error, complete)', () => {
    const ndjson = [
      '{"type":"status","phase":"setup","status":"setting_up"}',
      '{"type":"error","errorType":"review","message":"x"}',
      '{"type":"complete","findings":0}',
    ].join('\n');
    expect(parseCrCliAgentFindings(ndjson)).toEqual({ critical: 0, major: 0, minor: 0 });
  });
});

describe('decideExitCode', () => {
  it('returns 0 with reason "clean" on 0 critical + 0 major + 0 minor', () => {
    const v = decideExitCode({ critical: 0, major: 0, minor: 0 }, {});
    expect(v).toEqual({ exitCode: 0, reason: 'clean' });
  });

  it('returns 1 on any critical finding', () => {
    const v = decideExitCode({ critical: 2, major: 0, minor: 0 }, {});
    expect(v.exitCode).toBe(1);
    expect(v.reason).toMatch(/2 critical/);
  });

  it('returns 1 on any major finding (no critical)', () => {
    const v = decideExitCode({ critical: 0, major: 3, minor: 0 }, {});
    expect(v.exitCode).toBe(1);
    expect(v.reason).toMatch(/3 major/);
  });

  it('reports critical first when both critical and major are present', () => {
    // The reason field surfaces the highest severity first so the
    // operator/agent reads the most urgent class without scanning.
    const v = decideExitCode({ critical: 1, major: 5, minor: 0 }, {});
    expect(v.exitCode).toBe(1);
    expect(v.reason).toMatch(/critical/);
  });

  it('returns 0 with minor findings when --strict is OFF', () => {
    // Default discipline: minor findings are advisory; the gate fires
    // on critical+major only. --strict opts into a tighter gate.
    const v = decideExitCode({ critical: 0, major: 0, minor: 5 }, { strict: false });
    expect(v).toEqual({ exitCode: 0, reason: 'clean' });
  });

  it('returns 1 on minor findings with --strict ON', () => {
    const v = decideExitCode({ critical: 0, major: 0, minor: 5 }, { strict: true });
    expect(v.exitCode).toBe(1);
    expect(v.reason).toMatch(/5 minor/);
    expect(v.reason).toMatch(/strict/);
  });

  it('still returns clean on 0/0/0 even with --strict', () => {
    const v = decideExitCode({ critical: 0, major: 0, minor: 0 }, { strict: true });
    expect(v).toEqual({ exitCode: 0, reason: 'clean' });
  });
});

describe('isCliErrorResult', () => {
  // The helper drives the gate's "did the CR CLI actually finish a
  // review?" decision. A false negative here means a truncated NDJSON
  // stream parses as zero findings and writes a clean `cr-precheck-run`
  // atom -- the exact silent-skip vector the spec section 3.1 closes. Each
  // case below pins one classification branch.

  it('classifies a clean exit (status 0, no signal, no error) as runnable', () => {
    const result = { status: 0, signal: null, error: undefined, stdout: '', stderr: '' };
    expect(isCliErrorResult(result)).toBe(false);
  });

  it('classifies a non-zero numeric exit as cli-error', () => {
    // CR CLI returning a non-zero status (auth error, network error,
    // CR-internal review failure) is the most common cli-error path.
    const result = { status: 1, signal: null, error: undefined, stdout: '', stderr: 'auth failed' };
    expect(isCliErrorResult(result)).toBe(true);
  });

  it('classifies a SIGTERM-terminated run as cli-error', () => {
    // Signal-terminated children return `{status: null, signal: 'SIG*'}`
    // with `result.error` UNSET. A status-only check would let this
    // fall through to the parser; the parser reads truncated NDJSON
    // as zero findings; the gate emits a clean atom and exits 0.
    // This regression test pins the signal branch so a future refactor
    // that drops the signal check fails loudly here before merge.
    const result = { status: null, signal: 'SIGTERM', error: undefined, stdout: '', stderr: '' };
    expect(isCliErrorResult(result)).toBe(true);
  });

  it('classifies a SIGKILL-terminated run as cli-error', () => {
    // Same shape as SIGTERM but a different signal name; verifies the
    // check is signal-presence not signal-equality.
    const result = { status: null, signal: 'SIGKILL', error: undefined, stdout: '', stderr: '' };
    expect(isCliErrorResult(result)).toBe(true);
  });

  it('classifies a spawn-level error (ENOENT, EACCES) as cli-error', () => {
    // `result.error` is the canonical spawn-failure signal: ENOENT
    // (binary missing post-detection), EACCES (permission denied at
    // exec), explicit timeout (when spawnSync gets a timeout opt).
    const result = {
      status: null,
      signal: null,
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
      stdout: '',
      stderr: '',
    };
    expect(isCliErrorResult(result)).toBe(true);
  });

  it('does NOT classify status===null with no signal and no error as cli-error', () => {
    // Defensive: this shape should not occur in practice (spawnSync
    // populates at least one of status/signal/error on every return)
    // but if it did, treating it as a cli-error would block valid runs.
    // The helper falls back to "runnable"; downstream parsing of the
    // empty stdout returns zero findings and the gate exits clean.
    // This is the SAME shape an empty-diff path would produce, but the
    // empty-diff guard upstream handles that earlier (see main()).
    const result = { status: null, signal: null, error: undefined, stdout: '', stderr: '' };
    expect(isCliErrorResult(result)).toBe(false);
  });

  it('handles null/undefined input defensively', () => {
    // Belt-and-suspenders: spawnSync should not return null, but a
    // future caller that passes a wrapper-shape result without
    // checking for null should not throw inside the classifier.
    expect(isCliErrorResult(null)).toBe(false);
    expect(isCliErrorResult(undefined)).toBe(false);
  });
});
