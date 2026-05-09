/**
 * Tests for the pipeline-reaper-TTLs canon-policy reader.
 *
 * Mirrors the shape of test/runtime/loop/reaper-ttls.test.ts so the two
 * tunable-substrate-knob readers reuse one pattern. These tests lock the
 * contract:
 *
 *   - returns the validated TTL set when a clean, well-formed policy
 *     atom exists with subject='pipeline-reaper-ttls'
 *   - returns null on absence (caller falls through to env / defaults)
 *   - returns null + emits a stderr WARN on a malformed payload (the
 *     warning surfaces the operator-data error without crashing the
 *     reaper boot)
 *   - ignores tainted / superseded atoms so a revoked policy does not
 *     leak into resolution
 *   - skips atoms whose policy.subject does NOT match the discriminator
 *
 * Resolution-chain integration (canon > env > defaults) is asserted in
 * test/loop/runner.test.ts where the LoopRunner orchestrates the chain
 * (Task 5).
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { readPipelineReaperTtlsFromCanon } from '../../src/runtime/loop/pipeline-reaper-ttls.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

const NOW = '2026-05-09T00:00:00.000Z' as Time;

/**
 * Direct console.error replacement for capture-on-test. The vitest
 * config in this repo runs with `globals: false` and the
 * vi.spyOn(console, 'error') interception has been unreliable in
 * that mode; direct replacement works in both contexts.
 */
function captureStderr(): {
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
  restore: () => void;
} {
  const original = console.error;
  const captured: unknown[][] = [];
  // Wrap as `typeof console.error` so we don't reach for an `any` cast
  // (the architectural guard rejects `any` in tracked TS sources).
  const replacement: typeof console.error = (...args: unknown[]): void => {
    captured.push(args);
  };
  console.error = replacement;
  return {
    calls: captured,
    restore: () => {
      console.error = original;
    },
  };
}

/**
 * Run readPipelineReaperTtlsFromCanon with stderr captured, restoring
 * the original console.error in a finally block so a thrown reader does
 * not leak the patched global into later tests. Returns the reader's
 * result alongside the captured calls so the assertion shape stays
 * identical to the previous inline pattern. Extracted per the
 * substrate's N=2 duplication rule (the inline shape repeated across the
 * malformed-payload tests below).
 */
async function readWithCapturedStderr(
  host: ReturnType<typeof createMemoryHost>,
): Promise<{
  readonly ttls: Awaited<ReturnType<typeof readPipelineReaperTtlsFromCanon>>;
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
}> {
  const cap = captureStderr();
  try {
    const ttls = await readPipelineReaperTtlsFromCanon(host);
    return { ttls, calls: cap.calls };
  } finally {
    cap.restore();
  }
}

interface PolicyFields {
  readonly terminal_pipeline_ms?: unknown;
  readonly hil_paused_pipeline_ms?: unknown;
  readonly agent_session_ms?: unknown;
}

/**
 * Build a directive atom with metadata.policy carrying the
 * pipeline-reaper-ttls discriminator. Numeric fields are unknown so
 * tests can drive non-numeric / out-of-range values through one builder.
 */
function policyAtom(id: string, fields: PolicyFields): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'pipeline-reaper TTLs',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
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
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'pipeline-reaper-ttls',
        ...fields,
      },
    },
  };
}

const VALID = {
  terminal_pipeline_ms: 30 * 24 * 60 * 60 * 1000,
  hil_paused_pipeline_ms: 14 * 24 * 60 * 60 * 1000,
  agent_session_ms: 30 * 24 * 60 * 60 * 1000,
} as const;

describe('readPipelineReaperTtlsFromCanon', () => {
  it('returns null when no canon atom exists', async () => {
    const host = createMemoryHost();
    expect(await readPipelineReaperTtlsFromCanon(host)).toBeNull();
  });

  it('returns the configured TTLs when a valid canon atom exists', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-pipeline-reaper-ttls-default', VALID));
    const ttls = await readPipelineReaperTtlsFromCanon(host);
    expect(ttls).toEqual({
      terminalPipelineMs: VALID.terminal_pipeline_ms,
      hilPausedPipelineMs: VALID.hil_paused_pipeline_ms,
      agentSessionMs: VALID.agent_session_ms,
    });
  });

  it('returns null + warns when terminal_pipeline_ms is non-integer', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bad-terminal', { ...VALID, terminal_pipeline_ms: 1.5 }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('malformed payload');
    expect(String(calls[0]?.[0])).toContain('terminal_pipeline_ms');
  });

  it('returns null + warns when terminal_pipeline_ms is zero or negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-zero-terminal', { ...VALID, terminal_pipeline_ms: 0 }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns null + warns when hil_paused_pipeline_ms is non-integer', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bad-hil', { ...VALID, hil_paused_pipeline_ms: 0.5 }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('hil_paused_pipeline_ms');
  });

  it('returns null + warns when hil_paused_pipeline_ms is zero or negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-neg-hil', { ...VALID, hil_paused_pipeline_ms: -1 }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns null + warns when agent_session_ms is non-integer', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bad-session', { ...VALID, agent_session_ms: 2.5 }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('agent_session_ms');
  });

  it('returns null + warns when agent_session_ms is zero or negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-zero-session', { ...VALID, agent_session_ms: 0 }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns null + warns when terminal_pipeline_ms is missing', async () => {
    const host = createMemoryHost();
    // Builder accepts undefined to omit the numeric value while
    // preserving the subject discriminator.
    await host.atoms.put(
      policyAtom('pol-missing-terminal', {
        terminal_pipeline_ms: undefined,
        hil_paused_pipeline_ms: VALID.hil_paused_pipeline_ms,
        agent_session_ms: VALID.agent_session_ms,
      }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns null + warns when hil_paused_pipeline_ms is missing', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-missing-hil', {
        terminal_pipeline_ms: VALID.terminal_pipeline_ms,
        hil_paused_pipeline_ms: undefined,
        agent_session_ms: VALID.agent_session_ms,
      }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns null + warns when agent_session_ms is missing', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-missing-session', {
        terminal_pipeline_ms: VALID.terminal_pipeline_ms,
        hil_paused_pipeline_ms: VALID.hil_paused_pipeline_ms,
        agent_session_ms: undefined,
      }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns null + warns when a numeric field is non-numeric', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-string-terminal', { ...VALID, terminal_pipeline_ms: 'forever' }),
    );
    const { ttls, calls } = await readWithCapturedStderr(host);
    expect(ttls).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('ignores tainted canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-tainted', VALID);
    await host.atoms.put({ ...a, taint: 'tainted' });
    expect(await readPipelineReaperTtlsFromCanon(host)).toBeNull();
  });

  it('ignores superseded canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-superseded', VALID);
    await host.atoms.put({ ...a, superseded_by: ['pol-newer' as AtomId] });
    expect(await readPipelineReaperTtlsFromCanon(host)).toBeNull();
  });

  it('skips atoms whose policy.subject is not "pipeline-reaper-ttls"', async () => {
    const host = createMemoryHost();
    // A directive atom with a different subject must not be misread as a
    // pipeline-reaper-TTLs policy. The subject discriminator is
    // load-bearing; mis-routing would let an unrelated atom dictate the
    // pipeline reaper cadence.
    const unrelated: Atom = {
      ...policyAtom('pol-other', VALID),
      metadata: {
        policy: {
          subject: 'reaper-ttls',
          warn_ms: 60_000,
          abandon_ms: 120_000,
        },
      },
    };
    await host.atoms.put(unrelated);
    expect(await readPipelineReaperTtlsFromCanon(host)).toBeNull();
  });
});
