import type {
  Atom,
  AtomId,
  Event,
  PlanState,
  Principal,
  PrincipalId,
  Time,
} from '../src/types.js';

let atomCounter = 0;

export function sampleAtom(overrides: Partial<Atom> = {}): Atom {
  atomCounter += 1;
  const defaults: Atom = {
    schema_version: 1,
    id: `atom_${atomCounter}` as AtomId,
    content: 'sample content',
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { session_id: 'sess1', agent_id: 'agent1' },
      derived_from: [],
    },
    confidence: 0.5,
    created_at: `2026-01-01T00:00:00.${String(atomCounter).padStart(3, '0')}Z` as Time,
    last_reinforced_at: `2026-01-01T00:00:00.${String(atomCounter).padStart(3, '0')}Z` as Time,
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
    principal_id: 'user_1' as PrincipalId,
    taint: 'clean',
    metadata: {},
  };
  return { ...defaults, ...overrides };
}

let principalCounter = 0;

export function samplePrincipal(overrides: Partial<Principal> = {}): Principal {
  principalCounter += 1;
  const defaults: Principal = {
    id: `principal_${principalCounter}` as PrincipalId,
    name: `Principal ${principalCounter}`,
    role: 'agent',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1'],
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: null,
    created_at: '2026-01-01T00:00:00.000Z' as Time,
  };
  return { ...defaults, ...overrides };
}

/**
 * Build a plan-typed Atom with a configurable creation timestamp and
 * plan_state. Shared by tests that exercise the plan state machine
 * (reaper, dispatch, approval) so each suite uses the same atom shape.
 * The created_at + last_reinforced_at fields are pinned to the same
 * value so callers controlling time pinning can compute age cleanly.
 */
export function samplePlanAtom(
  id: string,
  createdAt: string,
  overrides: { plan_state?: PlanState } = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 0.9,
    created_at: createdAt as Time,
    last_reinforced_at: createdAt as Time,
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
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: { title: 'test plan' },
    plan_state: overrides.plan_state ?? 'proposed',
  };
}

export function sampleEvent(overrides: Partial<Event> = {}): Event {
  const defaults: Event = {
    kind: 'proposal',
    severity: 'info',
    summary: 'Test notification',
    body: 'A test event body.',
    atom_refs: [],
    principal_id: 'user_1' as PrincipalId,
    created_at: '2026-01-01T00:00:00.000Z' as Time,
  };
  return { ...defaults, ...overrides };
}

export function resetCounters(): void {
  atomCounter = 0;
  principalCounter = 0;
}
