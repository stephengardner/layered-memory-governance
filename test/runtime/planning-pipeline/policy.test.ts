import { describe, expect, it } from 'vitest';
import {
  readPipelineStagesPolicy,
  readPipelineStageHilPolicy,
  readPipelineDefaultModePolicy,
  readPipelineStageCostCapPolicy,
  readPipelineStageTimeoutPolicy,
  readPipelineCostCapPolicy,
  readPipelineStageImplementationsPolicy,
} from '../../../src/runtime/planning-pipeline/policy.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-04-28T12:00:00.000Z' as Time;

function policyAtom(id: string, policy: Record<string, unknown>): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: id,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'op', session_id: 't' },
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
    principal_id: 'operator-principal' as PrincipalId,
    taint: 'clean',
    metadata: { policy },
  };
}

describe('readPipelineStagesPolicy', () => {
  it('returns the configured stages list', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-default', {
        subject: 'planning-pipeline-stages',
        scope: 'project',
        stages: [
          { name: 'brainstorm-stage', principal_id: 'brainstorm-actor' },
          { name: 'spec-stage', principal_id: 'spec-author' },
        ],
      }),
    );
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]?.name).toBe('brainstorm-stage');
    expect(result.stages[0]?.principal_id).toBe('brainstorm-actor');
    expect(result.atomId).toBe('pol-planning-pipeline-stages-default');
  });

  it('fail-closed: malformed stages array returns empty list', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-default', {
        subject: 'planning-pipeline-stages',
        scope: 'project',
        stages: 'not-an-array',
      }),
    );
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toEqual([]);
  });

  it('fail-closed: stage entry missing principal_id returns empty list', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-default', {
        subject: 'planning-pipeline-stages',
        scope: 'project',
        stages: [{ name: 'brainstorm-stage' }],
      }),
    );
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toEqual([]);
  });

  it('fail-closed: duplicate stage names return empty list', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-default', {
        subject: 'planning-pipeline-stages',
        scope: 'project',
        stages: [
          { name: 'brainstorm-stage', principal_id: 'brainstorm-actor' },
          { name: 'brainstorm-stage', principal_id: 'other-actor' },
        ],
      }),
    );
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toEqual([]);
  });

  it('returns empty list with null atomId when no policy atom is present', async () => {
    const host = createMemoryHost();
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toEqual([]);
    expect(result.atomId).toBeNull();
  });

  it('source-rank arbitration: principal scope beats project scope when ctx.scope matches the principal', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-project', {
        subject: 'planning-pipeline-stages',
        scope: 'project',
        stages: [{ name: 'project-stage', principal_id: 'project-actor' }],
      }),
    );
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-cto', {
        subject: 'planning-pipeline-stages',
        scope: 'principal:cto-actor',
        stages: [{ name: 'principal-stage', principal_id: 'principal-actor' }],
      }),
    );
    // ctx.scope must match the principal-scoped policy for it to apply.
    const result = await readPipelineStagesPolicy(host, {
      scope: 'principal:cto-actor',
    });
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.name).toBe('principal-stage');
  });

  it('principal-scoped policy does NOT leak into project-scope query', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-project', {
        subject: 'planning-pipeline-stages',
        scope: 'project',
        stages: [{ name: 'project-stage', principal_id: 'project-actor' }],
      }),
    );
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-cto', {
        subject: 'planning-pipeline-stages',
        scope: 'principal:cto-actor',
        stages: [{ name: 'principal-stage', principal_id: 'principal-actor' }],
      }),
    );
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.name).toBe('project-stage');
  });

  it('skips superseded atoms', async () => {
    const host = createMemoryHost();
    const superseded: Atom = {
      ...policyAtom('pol-planning-pipeline-stages-old', {
        subject: 'planning-pipeline-stages',
        scope: 'principal:cto-actor',
        stages: [{ name: 'old-stage', principal_id: 'old-actor' }],
      }),
      superseded_by: ['pol-planning-pipeline-stages-new' as AtomId],
    };
    await host.atoms.put(superseded);
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stages-new', {
        subject: 'planning-pipeline-stages',
        scope: 'project',
        stages: [{ name: 'new-stage', principal_id: 'new-actor' }],
      }),
    );
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.name).toBe('new-stage');
  });
});

describe('readPipelineStageHilPolicy', () => {
  it('returns the configured pause_mode and resumers when matched', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-hil-spec', {
        subject: 'pipeline-stage-hil',
        stage_name: 'spec-stage',
        pause_mode: 'on-critical-finding',
        auto_resume_after_ms: 60_000,
        allowed_resumers: ['operator-principal'],
      }),
    );
    const result = await readPipelineStageHilPolicy(host, 'spec-stage');
    expect(result.pause_mode).toBe('on-critical-finding');
    expect(result.auto_resume_after_ms).toBe(60_000);
    expect(result.allowed_resumers).toEqual(['operator-principal']);
  });

  it('returns "always" for unknown pause_mode (most-conservative default)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-hil-spec', {
        subject: 'pipeline-stage-hil',
        stage_name: 'spec-stage',
        pause_mode: 'whenever',
        allowed_resumers: ['operator-principal'],
      }),
    );
    const result = await readPipelineStageHilPolicy(host, 'spec-stage');
    expect(result.pause_mode).toBe('always');
  });

  it('returns "always" when no policy atom matches (fail-closed default)', async () => {
    const host = createMemoryHost();
    const result = await readPipelineStageHilPolicy(host, 'unknown-stage');
    expect(result.pause_mode).toBe('always');
    expect(result.auto_resume_after_ms).toBeNull();
    expect(result.allowed_resumers).toEqual([]);
  });

  it('non-string entries in allowed_resumers are filtered out', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-hil-spec', {
        subject: 'pipeline-stage-hil',
        stage_name: 'spec-stage',
        pause_mode: 'always',
        allowed_resumers: ['operator-principal', 42, null, 'cto-actor'],
      }),
    );
    const result = await readPipelineStageHilPolicy(host, 'spec-stage');
    expect(result.allowed_resumers).toEqual(['operator-principal', 'cto-actor']);
  });
});

describe('readPipelineDefaultModePolicy', () => {
  it('returns "single-pass" when no atom is present (indie floor)', async () => {
    const host = createMemoryHost();
    const result = await readPipelineDefaultModePolicy(host);
    expect(result.mode).toBe('single-pass');
  });

  it('returns "substrate-deep" when policy atom configures it', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-default-mode', {
        subject: 'planning-pipeline-default-mode',
        mode: 'substrate-deep',
      }),
    );
    const result = await readPipelineDefaultModePolicy(host);
    expect(result.mode).toBe('substrate-deep');
  });

  it('returns "single-pass" when mode is malformed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-default-mode', {
        subject: 'planning-pipeline-default-mode',
        mode: 'lightning-deep',
      }),
    );
    const result = await readPipelineDefaultModePolicy(host);
    expect(result.mode).toBe('single-pass');
  });
});

describe('readPipelineStageCostCapPolicy', () => {
  it('returns null when no per-stage atom exists', async () => {
    const host = createMemoryHost();
    const result = await readPipelineStageCostCapPolicy(host, 'spec-stage');
    expect(result.cap_usd).toBeNull();
  });

  it('returns the configured cap when present', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-cost-cap-spec', {
        subject: 'pipeline-stage-cost-cap',
        stage_name: 'spec-stage',
        cap_usd: 0.5,
      }),
    );
    const result = await readPipelineStageCostCapPolicy(host, 'spec-stage');
    expect(result.cap_usd).toBe(0.5);
  });

  it('returns null when cap_usd is non-positive (fail-closed on malformed value)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-cost-cap-spec', {
        subject: 'pipeline-stage-cost-cap',
        stage_name: 'spec-stage',
        cap_usd: -1,
      }),
    );
    const result = await readPipelineStageCostCapPolicy(host, 'spec-stage');
    expect(result.cap_usd).toBeNull();
  });
});

describe('readPipelineStageTimeoutPolicy', () => {
  it('returns null when no per-stage atom exists', async () => {
    const host = createMemoryHost();
    const result = await readPipelineStageTimeoutPolicy(host, 'spec-stage');
    expect(result.timeout_ms).toBeNull();
  });

  it('returns the configured timeout when present', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-timeout-spec', {
        subject: 'pipeline-stage-timeout',
        stage_name: 'spec-stage',
        timeout_ms: 30_000,
      }),
    );
    const result = await readPipelineStageTimeoutPolicy(host, 'spec-stage');
    expect(result.timeout_ms).toBe(30_000);
  });

  it('returns null when timeout_ms is non-positive (fail-closed on malformed value)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-timeout-spec', {
        subject: 'pipeline-stage-timeout',
        stage_name: 'spec-stage',
        timeout_ms: 0,
      }),
    );
    const result = await readPipelineStageTimeoutPolicy(host, 'spec-stage');
    expect(result.timeout_ms).toBeNull();
  });

  it('does not match a different stage name', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-timeout-spec', {
        subject: 'pipeline-stage-timeout',
        stage_name: 'spec-stage',
        timeout_ms: 60_000,
      }),
    );
    const result = await readPipelineStageTimeoutPolicy(host, 'plan-stage');
    expect(result.timeout_ms).toBeNull();
  });
});

describe('readPipelineCostCapPolicy', () => {
  it('returns null when no per-pipeline atom exists', async () => {
    const host = createMemoryHost();
    const result = await readPipelineCostCapPolicy(host);
    expect(result.cap_usd).toBeNull();
  });

  it('returns the configured cap when present', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-cost-cap', {
        subject: 'pipeline-cost-cap',
        cap_usd: 5,
      }),
    );
    const result = await readPipelineCostCapPolicy(host);
    expect(result.cap_usd).toBe(5);
  });

  it('returns null when cap_usd is non-positive (fail-closed on malformed value)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-cost-cap', {
        subject: 'pipeline-cost-cap',
        cap_usd: 0,
      }),
    );
    const result = await readPipelineCostCapPolicy(host);
    expect(result.cap_usd).toBeNull();
  });

  it('ignores per-stage atoms when reading the per-pipeline cap', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-pipeline-stage-cost-cap-spec', {
        subject: 'pipeline-stage-cost-cap',
        stage_name: 'spec-stage',
        cap_usd: 0.5,
      }),
    );
    const result = await readPipelineCostCapPolicy(host);
    expect(result.cap_usd).toBeNull();
  });
});

describe('readPipelineStageImplementationsPolicy', () => {
  it('returns empty map when no policy atom is present (caller falls back to single-shot)', async () => {
    const host = createMemoryHost();
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.implementations.size).toBe(0);
    expect(result.atomId).toBeNull();
  });

  it('returns the configured per-stage implementation modes', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-default', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: [
          { stage_name: 'brainstorm-stage', mode: 'agentic' },
          { stage_name: 'spec-stage', mode: 'single-shot' },
        ],
      }),
    );
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.implementations.get('brainstorm-stage')).toBe('agentic');
    expect(result.implementations.get('spec-stage')).toBe('single-shot');
    expect(result.atomId).toBe('pol-planning-pipeline-stage-implementations-default');
  });

  it('fail-closed: malformed implementations array returns empty map', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-default', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: 'not-an-array',
      }),
    );
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.implementations.size).toBe(0);
    expect(result.atomId).toBe('pol-planning-pipeline-stage-implementations-default');
  });

  it('fail-closed: entry missing mode returns empty map', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-default', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: [{ stage_name: 'brainstorm-stage' }],
      }),
    );
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.implementations.size).toBe(0);
  });

  it('fail-closed: unknown mode value returns empty map', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-default', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: [
          { stage_name: 'brainstorm-stage', mode: 'turbo-agentic' },
        ],
      }),
    );
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.implementations.size).toBe(0);
  });

  it('fail-closed: duplicate stage names return empty map', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-default', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: [
          { stage_name: 'brainstorm-stage', mode: 'agentic' },
          { stage_name: 'brainstorm-stage', mode: 'single-shot' },
        ],
      }),
    );
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.implementations.size).toBe(0);
  });

  it('source-rank arbitration: principal scope beats project scope when ctx.scope matches', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-project', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: [{ stage_name: 'brainstorm-stage', mode: 'single-shot' }],
      }),
    );
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-cto', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'principal:cto-actor',
        implementations: [{ stage_name: 'brainstorm-stage', mode: 'agentic' }],
      }),
    );
    const result = await readPipelineStageImplementationsPolicy(host, {
      scope: 'principal:cto-actor',
    });
    expect(result.implementations.get('brainstorm-stage')).toBe('agentic');
  });

  it('principal-scoped policy does NOT leak into project-scope query', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-project', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: [{ stage_name: 'brainstorm-stage', mode: 'single-shot' }],
      }),
    );
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-cto', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'principal:cto-actor',
        implementations: [{ stage_name: 'brainstorm-stage', mode: 'agentic' }],
      }),
    );
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.implementations.get('brainstorm-stage')).toBe('single-shot');
  });

  it('skips superseded atoms', async () => {
    const host = createMemoryHost();
    const superseded: Atom = {
      ...policyAtom('pol-planning-pipeline-stage-implementations-old', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: [{ stage_name: 'brainstorm-stage', mode: 'agentic' }],
      }),
      superseded_by: ['pol-planning-pipeline-stage-implementations-new' as AtomId],
    };
    await host.atoms.put(superseded);
    await host.atoms.put(
      policyAtom('pol-planning-pipeline-stage-implementations-new', {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        implementations: [{ stage_name: 'brainstorm-stage', mode: 'single-shot' }],
      }),
    );
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.implementations.get('brainstorm-stage')).toBe('single-shot');
  });
});
