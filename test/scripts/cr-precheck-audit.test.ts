/**
 * Unit tests for scripts/cr-precheck-audit.mjs pure helpers.
 *
 * The query companion composes a duration parser + an atom filter +
 * a captured_at sort + a one-line formatter. Each is pure (no fs /
 * network / process side-effects) so unit tests cover them directly.
 * The full main() orchestration that creates a FileHost + reads atoms
 * is exercised via a temp-rooted FileHost round trip below.
 *
 * Atom shape under test (matches scripts/cr-precheck.mjs Task 1
 * output):
 *   type: 'observation', layer: 'L0', scope: 'project'
 *   metadata.kind: 'cr-precheck-skip' | 'cr-precheck-run'
 *   metadata.cr_precheck_skip.captured_at OR metadata.cr_precheck_run.captured_at
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  filterAndSortAuditAtoms,
  formatAuditLine,
  getCapturedAt,
  parseAuditArgs,
  parseDuration,
  queryAuditAtoms,
} from '../../scripts/lib/cr-precheck-audit.mjs';
import { createFileHost } from '../../src/adapters/file/index.js';

// Build a project-scope observation atom matching the Task 1 shape.
// Keeping this synchronous / data-only here so the tests can exercise
// the pure helpers without spinning up a host. The FileHost round
// trip below uses the same shape end-to-end.
function makeAtom(
  kind: 'cr-precheck-skip' | 'cr-precheck-run',
  capturedAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = `${kind}-${capturedAt.replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 10)}`;
  const payload =
    kind === 'cr-precheck-skip'
      ? {
          reason: 'coderabbit-not-on-path',
          commit_sha: 'abc1234',
          cwd: '/tmp/x',
          os: 'linux',
          captured_at: capturedAt,
          ...extra,
        }
      : {
          commit_sha: 'def5678',
          findings: { critical: 0, major: 0, minor: 0 },
          cli_version: '0.4.2',
          duration_ms: 1234,
          captured_at: capturedAt,
          ...extra,
        };
  const metadata: Record<string, unknown> = { kind };
  if (kind === 'cr-precheck-skip') metadata.cr_precheck_skip = payload;
  else metadata.cr_precheck_run = payload;
  return {
    schema_version: 1,
    id,
    content: `cr-precheck ${kind === 'cr-precheck-skip' ? 'skipped' : 'ran'}`,
    type: 'observation',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'cr-precheck' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: capturedAt,
    last_reinforced_at: capturedAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'cr-precheck',
    taint: 'clean',
    metadata,
  };
}

describe('parseDuration', () => {
  it('parses hours suffix', () => {
    expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration('1h')).toBe(60 * 60 * 1000);
  });

  it('parses days suffix', () => {
    expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000);
  });

  it('parses years suffix', () => {
    // Year approximated as 365 days. Exact-month accuracy is not
    // worth the calendar-edge complexity for a coarse audit window.
    expect(parseDuration('1y')).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it('parses minutes and seconds suffixes (ergonomic for fast operator queries)', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
    expect(parseDuration('45s')).toBe(45 * 1000);
  });

  it('returns null on missing suffix', () => {
    expect(parseDuration('24')).toBe(null);
  });

  it('returns null on unsupported suffix', () => {
    // A bare 'w' (weeks) is not supported; pick days. A typo like
    // '24q' must not silently parse as zero / a default; the caller
    // surfaces an arg error instead.
    expect(parseDuration('24w')).toBe(null);
    expect(parseDuration('24q')).toBe(null);
  });

  it('returns null on non-numeric magnitude', () => {
    expect(parseDuration('xh')).toBe(null);
    expect(parseDuration('')).toBe(null);
  });

  it('returns null on negative or zero magnitude', () => {
    // A zero-window query is meaningless and a negative window is
    // a signed-argument bug; both fail closed rather than silently
    // returning every atom or none.
    expect(parseDuration('-1h')).toBe(null);
    expect(parseDuration('0h')).toBe(null);
  });
});

describe('getCapturedAt', () => {
  it('reads metadata.cr_precheck_skip.captured_at for skip atoms', () => {
    const a = makeAtom('cr-precheck-skip', '2026-04-25T10:00:00.000Z');
    expect(getCapturedAt(a)).toBe('2026-04-25T10:00:00.000Z');
  });

  it('reads metadata.cr_precheck_run.captured_at for run atoms', () => {
    const a = makeAtom('cr-precheck-run', '2026-04-25T11:00:00.000Z');
    expect(getCapturedAt(a)).toBe('2026-04-25T11:00:00.000Z');
  });

  it('returns null when the kind discriminator is missing', () => {
    expect(getCapturedAt({ metadata: {} } as never)).toBe(null);
    expect(getCapturedAt({} as never)).toBe(null);
  });

  it('returns null when the kind is set but the payload is absent', () => {
    // Hostile / drifted atom: discriminator says skip but no payload.
    // The audit query treats this as "unreadable timestamp" and lets
    // the atom drop out of duration filtering rather than crashing.
    expect(
      getCapturedAt({ metadata: { kind: 'cr-precheck-skip' } } as never),
    ).toBe(null);
  });
});

describe('filterAndSortAuditAtoms', () => {
  const t1 = '2026-04-25T01:00:00.000Z';
  const t2 = '2026-04-25T05:00:00.000Z';
  const t3 = '2026-04-25T10:00:00.000Z';
  const skip1 = makeAtom('cr-precheck-skip', t1);
  const skip2 = makeAtom('cr-precheck-skip', t2);
  const run1 = makeAtom('cr-precheck-run', t3);

  it('returns newest-first by captured_at', () => {
    const out = filterAndSortAuditAtoms([skip1, run1, skip2], {
      kind: 'all',
      sinceMs: null,
      limit: 50,
      now: new Date('2026-04-25T12:00:00.000Z').getTime(),
    });
    expect(out.map((a: { id: string }) => a.id)).toEqual([run1.id, skip2.id, skip1.id]);
  });

  it('filters by kind=skip', () => {
    const out = filterAndSortAuditAtoms([skip1, run1, skip2], {
      kind: 'skip',
      sinceMs: null,
      limit: 50,
      now: new Date('2026-04-25T12:00:00.000Z').getTime(),
    });
    expect(out.map((a: { id: string }) => a.id)).toEqual([skip2.id, skip1.id]);
  });

  it('filters by kind=run', () => {
    const out = filterAndSortAuditAtoms([skip1, run1, skip2], {
      kind: 'run',
      sinceMs: null,
      limit: 50,
      now: new Date('2026-04-25T12:00:00.000Z').getTime(),
    });
    expect(out.map((a: { id: string }) => a.id)).toEqual([run1.id]);
  });

  it('filters by --since duration (newer than now - sinceMs)', () => {
    // now=12:00, since=2h => cutoff=10:00. Only run1 (10:00) and any
    // newer make the cut. skip1 (01:00) and skip2 (05:00) are older
    // than the window and drop. Boundary inclusion (>= cutoff)
    // ensures we do not lose an atom that lands exactly on the edge.
    const out = filterAndSortAuditAtoms([skip1, run1, skip2], {
      kind: 'all',
      sinceMs: 2 * 60 * 60 * 1000,
      limit: 50,
      now: new Date('2026-04-25T12:00:00.000Z').getTime(),
    });
    expect(out.map((a: { id: string }) => a.id)).toEqual([run1.id]);
  });

  it('caps results at limit', () => {
    const out = filterAndSortAuditAtoms([skip1, run1, skip2], {
      kind: 'all',
      sinceMs: null,
      limit: 2,
      now: new Date('2026-04-25T12:00:00.000Z').getTime(),
    });
    expect(out.length).toBe(2);
    expect(out.map((a: { id: string }) => a.id)).toEqual([run1.id, skip2.id]);
  });

  it('returns empty array when nothing matches the kind filter', () => {
    const out = filterAndSortAuditAtoms([skip1, skip2], {
      kind: 'run',
      sinceMs: null,
      limit: 50,
      now: new Date('2026-04-25T12:00:00.000Z').getTime(),
    });
    expect(out).toEqual([]);
  });

  it('returns empty array when nothing falls within the duration window', () => {
    const out = filterAndSortAuditAtoms([skip1, skip2], {
      kind: 'all',
      sinceMs: 60 * 1000, // 1 minute window
      now: new Date('2026-04-25T12:00:00.000Z').getTime(),
      limit: 50,
    });
    expect(out).toEqual([]);
  });

  it('ignores non-cr-precheck atoms (other observation kinds)', () => {
    // The audit log lives alongside other observation atoms (kill-switch
    // events, agent-turn atoms, etc). The query must filter on the
    // cr-precheck-* discriminators only so the operator does not see
    // unrelated state when running this tool.
    const unrelated = {
      ...makeAtom('cr-precheck-skip', t1),
      metadata: { kind: 'kill-switch-tripped' },
    };
    const out = filterAndSortAuditAtoms([unrelated, skip2], {
      kind: 'all',
      sinceMs: null,
      limit: 50,
      now: new Date('2026-04-25T12:00:00.000Z').getTime(),
    });
    expect(out.map((a: { id: string }) => a.id)).toEqual([skip2.id]);
  });
});

describe('parseAuditArgs', () => {
  it('returns defaults on no args', () => {
    expect(parseAuditArgs([])).toEqual({ since: null, kind: 'all', limit: 50 });
  });

  it('parses --kind skip / run / all', () => {
    expect(parseAuditArgs(['--kind', 'skip']).kind).toBe('skip');
    expect(parseAuditArgs(['--kind', 'run']).kind).toBe('run');
    expect(parseAuditArgs(['--kind', 'all']).kind).toBe('all');
  });

  it('parses --since duration string verbatim (parser validates it later)', () => {
    expect(parseAuditArgs(['--since', '24h']).since).toBe('24h');
    expect(parseAuditArgs(['--since', '7d']).since).toBe('7d');
  });

  it('parses --limit as integer', () => {
    expect(parseAuditArgs(['--limit', '10']).limit).toBe(10);
  });
});

describe('formatAuditLine', () => {
  it('renders a skip atom with reason + commit + os', () => {
    const a = makeAtom('cr-precheck-skip', '2026-04-25T10:00:00.000Z', {
      reason: 'coderabbit-not-on-path',
      commit_sha: 'abc1234',
      os: 'win32',
    });
    const line = formatAuditLine(a);
    expect(line).toMatch(/2026-04-25T10:00:00\.000Z/);
    expect(line).toMatch(/skip/);
    expect(line).toMatch(/coderabbit-not-on-path/);
    expect(line).toMatch(/abc1234/);
  });

  it('renders a run atom with finding counts + cli version', () => {
    const a = makeAtom('cr-precheck-run', '2026-04-25T11:00:00.000Z', {
      findings: { critical: 1, major: 2, minor: 3 },
      cli_version: '0.4.2',
      commit_sha: 'def5678',
    });
    const line = formatAuditLine(a);
    expect(line).toMatch(/2026-04-25T11:00:00\.000Z/);
    expect(line).toMatch(/run/);
    expect(line).toMatch(/c=1.*m=2.*n=3/);
    expect(line).toMatch(/0\.4\.2/);
    expect(line).toMatch(/def5678/);
  });
});

describe('queryAuditAtoms (FileHost round trip)', () => {
  it('reads seeded atoms from a temp host and returns them newest-first', async () => {
    // End-to-end: write the same atoms cr-precheck.mjs writes, then
    // query through the audit helper using a real FileHost. Pins the
    // contract that the audit script's read path matches the helper's
    // write path (a drift here would silently hide every audit atom).
    const dir = mkdtempSync(join(tmpdir(), 'lag-cr-precheck-audit-'));
    try {
      const host = await createFileHost({ rootDir: dir });
      const skip = makeAtom('cr-precheck-skip', '2026-04-25T01:00:00.000Z');
      const run = makeAtom('cr-precheck-run', '2026-04-25T10:00:00.000Z');
      await host.atoms.put(skip as never);
      await host.atoms.put(run as never);

      const out = await queryAuditAtoms(host, {
        kind: 'all',
        sinceMs: null,
        limit: 50,
        now: new Date('2026-04-25T12:00:00.000Z').getTime(),
      });
      expect(out.map((a: { id: string }) => a.id)).toEqual([run.id, skip.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty array when the host has no cr-precheck atoms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lag-cr-precheck-audit-empty-'));
    try {
      const host = await createFileHost({ rootDir: dir });
      const out = await queryAuditAtoms(host, {
        kind: 'all',
        sinceMs: null,
        limit: 50,
        now: Date.now(),
      });
      expect(out).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
