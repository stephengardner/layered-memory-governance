/**
 * Phase 2 PR1 schema-additive test for the optional AuditFinding.reprompt_target field.
 *
 * The runner machinery that ACTS on reprompt_target ships in subsequent
 * PRs of the cross-stage deliberation spec arc. This test exists to pin
 * (a) that the field is optional and findings without it remain valid,
 * (b) that the field accepts string stage names when set, and (c) that
 * setting it does not change the runtime shape consumers see (it's
 * additive in TypeScript and additive in plain JS object literals).
 *
 * Scope per spec section 'Mechanism: scoped findings' in
 * docs/superpowers/specs/2026-05-12-cross-stage-reprompt-deliberation-design.md.
 */

import { describe, expect, it } from 'vitest';
import type { AuditFinding } from '../../../src/runtime/planning-pipeline/types.js';
import type { AtomId } from '../../../src/types.js';

describe('AuditFinding.reprompt_target (additive, Phase 2 PR1)', () => {
  it('accepts a finding without reprompt_target (existing shape unchanged)', () => {
    const finding: AuditFinding = {
      severity: 'critical',
      category: 'dispatch-gated',
      message: 'upstream not clean',
      cited_atom_ids: [] as ReadonlyArray<AtomId>,
      cited_paths: [],
    };
    expect(finding.reprompt_target).toBeUndefined();
    expect(finding.severity).toBe('critical');
  });

  it('accepts a finding with reprompt_target set to an upstream stage name', () => {
    const finding: AuditFinding = {
      severity: 'critical',
      category: 'dispatch-drafter-refusal',
      message: 'drafter refused plan; re-prompt plan-stage with notes',
      cited_atom_ids: [] as ReadonlyArray<AtomId>,
      cited_paths: [],
      reprompt_target: 'plan-stage',
    };
    expect(finding.reprompt_target).toBe('plan-stage');
  });

  it('reprompt_target is a plain string at runtime (JSON-serializable)', () => {
    const finding: AuditFinding = {
      severity: 'major',
      category: 'review-citation-fabrication',
      message: 'plan cites atom not in verified set',
      cited_atom_ids: [] as ReadonlyArray<AtomId>,
      cited_paths: [],
      reprompt_target: 'plan-stage',
    };
    const json = JSON.stringify(finding);
    const parsed = JSON.parse(json) as AuditFinding;
    expect(parsed.reprompt_target).toBe('plan-stage');
    expect(parsed.severity).toBe('major');
  });

  it('a finding with reprompt_target equal to the auditing stage name is structurally valid (runner treats as intra-stage)', () => {
    const finding: AuditFinding = {
      severity: 'minor',
      category: 'self-target-noop',
      message: 'self-targeted re-prompt falls back to intra-stage path per spec',
      cited_atom_ids: [] as ReadonlyArray<AtomId>,
      cited_paths: [],
      reprompt_target: 'dispatch-stage',
    };
    expect(finding.reprompt_target).toBe('dispatch-stage');
  });
});
