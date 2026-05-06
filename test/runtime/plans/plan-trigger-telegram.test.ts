/**
 * Unit tests for runPlanProposalNotifyTick.
 *
 * Pins:
 *   - allowlist enforcement (cto-actor / cpo-actor by default)
 *   - idempotence via plan-push-record atoms
 *   - rate-limiting at maxNotifies
 *   - taint + supersede defensive guards
 *   - notify-failed counted, push-record NOT written
 *   - canon allowlist override honored
 *   - principalAllowlistOverride option (test injection)
 *   - empty allowlist short-circuits without scanning
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { runPlanProposalNotifyTick } from '../../../src/runtime/plans/plan-trigger-telegram.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';
import { samplePlanAtom } from '../../fixtures.js';

const tickPrincipal = 'lag-loop' as PrincipalId;

interface NotifyCall {
  readonly planId: string;
  readonly content: string;
}

function buildPlanFor(
  id: string,
  principal: string,
  plan_state: 'proposed' | 'executing' | 'approved' | 'succeeded' | 'failed' | 'abandoned' = 'proposed',
): Atom {
  const a = samplePlanAtom(id, '2026-05-05T00:00:00.000Z', { plan_state });
  return {
    ...a,
    principal_id: principal as PrincipalId,
    content: `# ${id} title\n\nbody for ${id}.`,
  };
}

function recorder(): {
  calls: NotifyCall[];
  notifier: {
    notify: (args: { readonly plan: Atom }) => Promise<void>;
  };
} {
  const calls: NotifyCall[] = [];
  return {
    calls,
    notifier: {
      async notify(args) {
        calls.push({
          planId: args.plan.id,
          content: String(args.plan.content ?? ''),
        });
      },
    },
  };
}

describe('runPlanProposalNotifyTick', () => {
  it('notifies a new proposed plan from cto-actor (default allowlist)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.planId).toBe('p1');
    expect(calls[0]?.content).toContain('p1 title');
    // Idempotence record was written.
    const records = await host.atoms.query({ type: ['plan-push-record'] }, 50);
    expect(records.atoms.length).toBe(1);
    const record = records.atoms[0]!;
    expect((record.metadata as Record<string, unknown>)['plan_id']).toBe('p1');
    expect(record.provenance.derived_from).toEqual(['p1']);
    expect(record.principal_id).toBe(tickPrincipal);
  });

  it('notifies a cpo-actor plan too (default allowlist includes both)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cpo-actor'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(1);
    expect(calls[0]?.planId).toBe('p1');
  });

  it('is idempotent: re-running the tick on the same state does NOT re-notify', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor'));
    const { calls, notifier } = recorder();
    const first = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(first.notified).toBe(1);
    const second = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(second.notified).toBe(0);
    expect(second.skipped['already-pushed']).toBe(1);
    expect(calls.length).toBe(1);
  });

  it('skips plans whose principal is NOT in the allowlist', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'code-author'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(0);
    expect(result.skipped['not-in-allowlist']).toBe(1);
    expect(calls.length).toBe(0);
  });

  it('only sees proposed plans (the AtomFilter narrows by plan_state)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor', 'executing'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('honors the canon allowlist override', async () => {
    const host = createMemoryHost();
    // Canon override: only cto-actor (cpo dropped).
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-telegram' as AtomId,
      content: 'telegram-plan-trigger principals policy',
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'operator-seeded',
        source: { agent_id: 'bootstrap' },
        derived_from: [],
      },
      confidence: 1,
      created_at: '2026-05-05T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-05-05T00:00:00.000Z' as Time,
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
          subject: 'telegram-plan-trigger-principals',
          principal_ids: ['cto-actor'],
        },
      },
    });
    await host.atoms.put(buildPlanFor('p1', 'cpo-actor'));
    await host.atoms.put(buildPlanFor('p2', 'cto-actor'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.planId).toBe('p2');
    expect(result.skipped['not-in-allowlist']).toBe(1);
  });

  it('counts notify-failed and does NOT write push-record on adapter throw', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor'));
    const notifier = {
      async notify(): Promise<void> {
        throw new Error('synthetic Telegram failure');
      },
    };
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(0);
    expect(result.skipped['notify-failed']).toBe(1);
    // No push-record was written -> next tick will retry.
    const records = await host.atoms.query({ type: ['plan-push-record'] }, 50);
    expect(records.atoms.length).toBe(0);
  });

  it('rate-limits at maxNotifies', async () => {
    const host = createMemoryHost();
    for (let i = 0; i < 5; i += 1) {
      await host.atoms.put(buildPlanFor(`p${i}`, 'cto-actor'));
    }
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal, {
      maxNotifies: 2,
    });
    expect(result.notified).toBe(2);
    expect(result.skipped['rate-limited']).toBe(3);
    expect(calls.length).toBe(2);
  });

  it('skips tainted and superseded plans defensively', async () => {
    const host = createMemoryHost();
    const tainted = buildPlanFor('p1', 'cto-actor');
    tainted.taint = 'tainted';
    await host.atoms.put(tainted);
    const superseded = buildPlanFor('p2', 'cto-actor');
    superseded.superseded_by = ['p2-newer' as AtomId];
    await host.atoms.put(superseded);
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(0);
    expect(calls.length).toBe(0);
    // The pass should still scan them (advisory guards bump the
    // skipped histogram) so the operator sees defensive skips in
    // the per-tick report.
    expect((result.skipped['tainted'] ?? 0) + (result.skipped['superseded'] ?? 0)).toBeGreaterThan(0);
  });

  it('uses the principalAllowlistOverride option (test injection bypassing canon read)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'maverick-actor'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal, {
      principalAllowlistOverride: ['maverick-actor' as PrincipalId],
    });
    expect(result.notified).toBe(1);
    expect(calls.length).toBe(1);
  });

  it('short-circuits with an explicit empty allowlist (canon opt-out)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal, {
      principalAllowlistOverride: [],
    });
    expect(result.notified).toBe(0);
    expect(result.scanned).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('uses the now() option for the push-record timestamp when supplied', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor'));
    const { notifier } = recorder();
    const fixedNow = '2026-05-05T12:00:00.000Z';
    await runPlanProposalNotifyTick(host, notifier, tickPrincipal, {
      now: () => fixedNow,
    });
    const records = await host.atoms.query({ type: ['plan-push-record'] }, 50);
    expect(records.atoms.length).toBe(1);
    expect(records.atoms[0]?.created_at).toBe(fixedNow);
    expect((records.atoms[0]?.metadata as Record<string, unknown>)['pushed_at']).toBe(fixedNow);
  });
});
