import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import type { AuditEvent, PrincipalId, Time } from '../../src/substrate/types.js';
import { runAuditorSpec } from './shared/auditor-spec.js';

runAuditorSpec('memory', async () => ({ host: createMemoryHost() }));

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    kind: 'atom.put',
    principal_id: 'user_1' as PrincipalId,
    timestamp: '2026-01-01T00:00:00.000Z' as Time,
    refs: {},
    details: {},
    ...overrides,
  };
}

describe('MemoryAuditor adapter-specific helpers', () => {
  it('size grows monotonically with each log call', async () => {
    const host = createMemoryHost();
    for (let i = 0; i < 5; i++) {
      const before = host.auditor.size();
      await host.auditor.log(event({ kind: `k${i}` }));
      const after = host.auditor.size();
      expect(after).toBeGreaterThanOrEqual(before);
    }
    expect(host.auditor.size()).toBe(5);
  });

  it('allMetrics returns recorded metric emissions with tags', () => {
    const host = createMemoryHost();
    host.auditor.metric('atoms.written', 5, { layer: 'L1' });
    host.auditor.metric('atoms.written', 7, { layer: 'L2' });
    const all = host.auditor.allMetrics();
    expect(all.length).toBe(2);
    expect(all[0]?.name).toBe('atoms.written');
    expect(all[0]?.tags?.layer).toBe('L1');
  });
});
