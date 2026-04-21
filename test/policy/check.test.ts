/**
 * checkToolPolicy tests (Phase 52a).
 *
 * Covers:
 *   - Default allow when canon has no tool-use policies.
 *   - Exact match wins.
 *   - Wildcard matches but loses to exact.
 *   - Regex (^prefix) matches and scores lower than exact.
 *   - Deny policy returns deny.
 *   - Escalate policy returns escalate.
 *   - Priority breaks specificity ties.
 *   - Atoms without metadata.policy are ignored.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  checkToolPolicy,
  matchSpecificity,
  parsePolicy,
} from '../../src/policy/index.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const operator = 'stephen-human' as PrincipalId;
const agent = 'claude-agent' as PrincipalId;

function policyAtom(id: string, policy: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return sampleAtom({
    id: id as AtomId,
    type: 'directive',
    layer: 'L3',
    confidence: 1.0,
    content: typeof policy.reason === 'string' ? policy.reason : id,
    metadata: { policy },
    ...overrides,
  });
}

describe('parsePolicy (pure)', () => {
  it('returns null for atoms without metadata.policy', () => {
    const atom = sampleAtom({ id: 'plain' as AtomId, layer: 'L3' });
    expect(parsePolicy(atom)).toBeNull();
  });

  it('returns null for policy missing required fields', () => {
    const atom = policyAtom('incomplete', { subject: 'tool-use' });
    expect(parsePolicy(atom)).toBeNull();
  });

  it('returns parsed shape for a valid policy', () => {
    const atom = policyAtom('p1', {
      subject: 'tool-use',
      tool: 'Bash',
      origin: 'telegram',
      principal: '*',
      action: 'escalate',
      reason: 'TG-origin Bash requires HIL',
    });
    const parsed = parsePolicy(atom);
    expect(parsed).not.toBeNull();
    expect(parsed!.tool).toBe('Bash');
    expect(parsed!.origin).toBe('telegram');
    expect(parsed!.action).toBe('escalate');
  });
});

describe('matchSpecificity (pure)', () => {
  const base = (o: Partial<Parameters<typeof policyAtom>[1]> = {}) => parsePolicy(
    policyAtom('x', {
      subject: 'tool-use',
      tool: '*',
      origin: '*',
      principal: '*',
      action: 'allow',
      ...o,
    })!,
  )!;

  it('exact literal match scores 4+4+4 = 12', () => {
    const p = base({ tool: 'Bash', origin: 'telegram', principal: String(operator) });
    const score = matchSpecificity(p, { tool: 'Bash', origin: 'telegram', principal: operator });
    expect(score).toBe(12);
  });

  it('all wildcards scores 1+1+1 = 3', () => {
    const p = base({});
    const score = matchSpecificity(p, { tool: 'Bash', origin: 'telegram', principal: operator });
    expect(score).toBe(3);
  });

  it('regex match scores 2 per field', () => {
    const p = base({ tool: '^(Bash|Edit)$', origin: '*', principal: '*' });
    const score = matchSpecificity(p, { tool: 'Bash', origin: 'telegram', principal: operator });
    expect(score).toBe(2 + 1 + 1);
  });

  it('no match returns null', () => {
    const p = base({ tool: 'Edit', origin: '*', principal: '*' });
    const score = matchSpecificity(p, { tool: 'Bash', origin: 'telegram', principal: operator });
    expect(score).toBeNull();
  });
});

describe('checkToolPolicy', () => {
  it('default-allow when canon has no policies', async () => {
    const host = createMemoryHost();
    const result = await checkToolPolicy(host, {
      tool: 'Bash',
      origin: 'terminal',
      principal: operator,
    });
    expect(result.decision).toBe('allow');
    expect(result.specificity).toBe(0);
    expect(result.reason).toMatch(/No tool-use policies/);
  });

  it('exact match wins over wildcard fallback', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('wild', {
      subject: 'tool-use',
      tool: '*',
      origin: '*',
      principal: '*',
      action: 'allow',
      reason: 'default',
    }));
    await host.atoms.put(policyAtom('specific', {
      subject: 'tool-use',
      tool: 'Bash',
      origin: 'telegram',
      principal: '*',
      action: 'escalate',
      reason: 'TG-origin Bash requires HIL',
    }));

    const result = await checkToolPolicy(host, {
      tool: 'Bash',
      origin: 'telegram',
      principal: agent,
    });
    expect(result.decision).toBe('escalate');
    expect(result.matchedAtomId).toBe('specific');
    expect(result.reason).toContain('HIL');
  });

  it('deny policy returns deny', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('block-rm', {
      subject: 'tool-use',
      tool: 'Bash',
      origin: '*',
      principal: '*',
      action: 'deny',
      reason: 'bash is blocked outright',
    }));
    const result = await checkToolPolicy(host, {
      tool: 'Bash',
      origin: 'terminal',
      principal: operator,
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('blocked');
  });

  it('priority breaks ties at equal specificity', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('low-prio', {
      subject: 'tool-use',
      tool: 'Bash',
      origin: 'telegram',
      principal: '*',
      action: 'allow',
      reason: 'low',
      priority: 0,
    }));
    await host.atoms.put(policyAtom('high-prio', {
      subject: 'tool-use',
      tool: 'Bash',
      origin: 'telegram',
      principal: '*',
      action: 'escalate',
      reason: 'high',
      priority: 10,
    }));
    const result = await checkToolPolicy(host, {
      tool: 'Bash',
      origin: 'telegram',
      principal: agent,
    });
    expect(result.decision).toBe('escalate');
    expect(result.matchedAtomId).toBe('high-prio');
  });

  it('ignores non-L3 atoms even if metadata.policy is present', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('l1-policy', {
      subject: 'tool-use',
      tool: '*',
      origin: '*',
      principal: '*',
      action: 'deny',
      reason: 'should be ignored (L1)',
    }, { layer: 'L1' }));
    const result = await checkToolPolicy(host, {
      tool: 'Bash',
      origin: 'terminal',
      principal: operator,
    });
    expect(result.decision).toBe('allow');
  });

  it('paginates across pages so policies beyond pageSize are not silently missed', async () => {
    // Regression: previous implementation fetched only the first page
    // (max 500), so a specific allow sitting beyond page 1 could be
    // missed, letting a broader deny win. Seed many wildcard allows
    // and ONE specific deny at the end; pagination must surface it.
    const host = createMemoryHost();
    // First, 15 wildcard allow policies (all match Bash loosely).
    for (let i = 0; i < 15; i++) {
      await host.atoms.put(policyAtom(`filler-${i}`, {
        subject: 'tool-use',
        tool: '*',
        origin: '*',
        principal: '*',
        action: 'allow',
        reason: `filler ${i}`,
      }));
    }
    // Final policy: specific deny for Bash. Would be missed with
    // pageSize=10 if pagination wasn't walking nextCursor.
    await host.atoms.put(policyAtom('specific-deny', {
      subject: 'tool-use',
      tool: 'Bash',
      origin: '*',
      principal: '*',
      action: 'deny',
      reason: 'specific bash deny after many fillers',
    }));
    const result = await checkToolPolicy(
      host,
      { tool: 'Bash', origin: 'terminal', principal: operator },
      { pageSize: 10 },
    );
    expect(result.decision).toBe('deny');
    expect(result.matchedAtomId).toBe('specific-deny');
  });

  it('regex policy matches a tool family', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('write-ops', {
      subject: 'tool-use',
      tool: '^(Write|Edit|MultiEdit)$',
      origin: 'telegram',
      principal: '*',
      action: 'escalate',
      reason: 'write-ops from Telegram require HIL',
    }));
    const a = await checkToolPolicy(host, {
      tool: 'Write', origin: 'telegram', principal: agent,
    });
    expect(a.decision).toBe('escalate');
    const b = await checkToolPolicy(host, {
      tool: 'Edit', origin: 'telegram', principal: agent,
    });
    expect(b.decision).toBe('escalate');
    const c = await checkToolPolicy(host, {
      tool: 'Read', origin: 'telegram', principal: agent,
    });
    expect(c.decision).toBe('allow');
  });
});
