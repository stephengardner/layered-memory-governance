/**
 * Tests for the cross-stage re-prompt canon-policy reader.
 *
 * Mirrors `auditor-feedback-reprompt-config.test.ts` and covers:
 *   - no canon atom -> null (caller falls through to hardcoded default)
 *   - well-formed atom -> validated config returned
 *   - allowed_targets accepts 'derive-from-pipeline-composition' literal
 *   - allowed_targets accepts non-empty string[]
 *   - malformed payloads (each field) -> null with warning
 *   - non-L3 layer ignored (impersonation guard)
 *   - tainted atom ignored (taint cascade guard)
 *   - superseded atom ignored
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  DERIVE_FROM_PIPELINE_COMPOSITION,
  HARDCODED_DEFAULT,
  readCrossStageRePromptPolicy,
} from '../../../src/runtime/planning-pipeline/cross-stage-reprompt-config.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

function mkPolicyAtom(opts: {
  id: string;
  layer?: 'L0' | 'L1' | 'L2' | 'L3';
  taint?: 'clean' | 'suspect' | 'compromised';
  superseded_by?: string[];
  policy: Record<string, unknown>;
}): Atom {
  return {
    schema_version: 1,
    id: opts.id as AtomId,
    content: 'policy atom',
    type: 'directive',
    layer: opts.layer ?? 'L3',
    provenance: {
      kind: 'human-asserted',
      source: { principal_id: 'apex-agent' as PrincipalId },
      derived_from: [],
    },
    confidence: 1,
    created_at: '2026-05-13T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-05-13T00:00:00.000Z' as Time,
    expires_at: null,
    supersedes: [],
    superseded_by: (opts.superseded_by ?? []) as ReadonlyArray<AtomId>,
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'apex-agent' as PrincipalId,
    taint: opts.taint ?? 'clean',
    metadata: { policy: opts.policy },
  };
}

describe('readCrossStageRePromptPolicy', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns null when no policy atom exists', async () => {
    const host = createMemoryHost();
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
  });

  it('returns the validated config from a well-formed policy atom (derive-targets variant)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-cross-stage-reprompt-default',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 3,
          severities_to_reprompt: ['critical', 'major'],
          allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toEqual({
      max_attempts: 3,
      severities_to_reprompt: ['critical', 'major'],
      allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
    });
  });

  it('returns the validated config from a well-formed policy atom (literal-list variant)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-cross-stage-reprompt-narrow',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 2,
          severities_to_reprompt: ['critical'],
          allowed_targets: ['plan-stage'],
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toEqual({
      max_attempts: 2,
      severities_to_reprompt: ['critical'],
      allowed_targets: ['plan-stage'],
    });
  });

  it('returns null + warns when max_attempts is not a positive integer', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-bad-max-attempts',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 0,
          severities_to_reprompt: ['critical'],
          allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalled();
    expect(stderrSpy.mock.calls[0]?.[0]).toContain('max_attempts=0');
  });

  it('returns null + warns when severities_to_reprompt is not an array', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-bad-sev-type',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 2,
          severities_to_reprompt: 'critical',
          allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('returns null + warns when a severity entry is unknown', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-bad-sev-value',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 2,
          severities_to_reprompt: ['critical', 'urgent'],
          allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
  });

  it('returns null + warns when allowed_targets is an unrecognized string', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-bad-targets-string',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 2,
          severities_to_reprompt: ['critical'],
          allowed_targets: 'all',
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
  });

  it('returns null + warns when allowed_targets is an empty array', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-bad-targets-empty',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 2,
          severities_to_reprompt: ['critical'],
          allowed_targets: [],
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
  });

  it('returns null + warns when allowed_targets entry is not a non-empty string', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-bad-targets-entry',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 2,
          severities_to_reprompt: ['critical'],
          allowed_targets: ['plan-stage', ''],
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
  });

  it('ignores a non-L3 atom with matching subject (impersonation guard)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-not-l3',
        layer: 'L1',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 99,
          severities_to_reprompt: ['critical', 'major', 'minor'],
          allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
  });

  it('ignores a tainted atom (taint cascade guard)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-tainted',
        taint: 'compromised',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 99,
          severities_to_reprompt: ['critical'],
          allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
  });

  it('ignores a superseded atom', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-superseded',
        superseded_by: ['pol-newer'],
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 99,
          severities_to_reprompt: ['critical'],
          allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toBeNull();
  });

  it('HARDCODED_DEFAULT matches the indie floor spec (max=2, critical only, derive)', () => {
    expect(HARDCODED_DEFAULT.max_attempts).toBe(2);
    expect(HARDCODED_DEFAULT.severities_to_reprompt).toEqual(['critical']);
    expect(HARDCODED_DEFAULT.allowed_targets).toBe(DERIVE_FROM_PIPELINE_COMPOSITION);
  });

  it('severities_to_reprompt empty array is valid (explicit disable)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      mkPolicyAtom({
        id: 'pol-empty-sev',
        policy: {
          subject: 'cross-stage-reprompt-default',
          max_attempts: 2,
          severities_to_reprompt: [],
          allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
        },
      }),
    );
    const result = await readCrossStageRePromptPolicy(host);
    expect(result).toEqual({
      max_attempts: 2,
      severities_to_reprompt: [],
      allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
    });
  });
});
