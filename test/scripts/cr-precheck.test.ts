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
