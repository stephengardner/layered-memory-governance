import { describe, expect, it } from 'vitest';
import { PLAN_DRAFT } from '../../src/schemas/index.js';

const valid = {
  title: 'Fix X',
  body: 'Detailed body.',
  derived_from: ['dev-canon-is-strategic-not-tactical'],
  principles_applied: ['dev-right-over-easy-for-external-actions'],
  alternatives_rejected: [],
  what_breaks_if_revisit: 'Sound at 3 months: simple surface.',
  confidence: 0.8,
  delegation: {
    sub_actor_principal_id: 'code-author',
    reason: 'Change requires PR to src/schemas.',
    implied_blast_radius: 'framework',
  },
};

describe('PLAN_DRAFT schema', () => {
  it('accepts a well-formed plan with delegation', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({ plans: [valid] });
    expect(res.success).toBe(true);
  });
  it('rejects when delegation is missing', () => {
    const { delegation, ...withoutDelegation } = valid;
    const res = PLAN_DRAFT.zodSchema.safeParse({ plans: [withoutDelegation] });
    expect(res.success).toBe(false);
  });
  it('accepts any non-empty sub_actor_principal_id (deployment-agnostic)', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({
      plans: [{ ...valid, delegation: { ...valid.delegation, sub_actor_principal_id: 'deploy-actor' } }],
    });
    expect(res.success).toBe(true);
  });
  it('rejects when sub_actor_principal_id is empty', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({
      plans: [{ ...valid, delegation: { ...valid.delegation, sub_actor_principal_id: '' } }],
    });
    expect(res.success).toBe(false);
  });
  it('rejects when implied_blast_radius is invalid', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({
      plans: [{ ...valid, delegation: { ...valid.delegation, implied_blast_radius: 'everything' } }],
    });
    expect(res.success).toBe(false);
  });
  it('rejects when reason is empty', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({
      plans: [{ ...valid, delegation: { ...valid.delegation, reason: '' } }],
    });
    expect(res.success).toBe(false);
  });
});
