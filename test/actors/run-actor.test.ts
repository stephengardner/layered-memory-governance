/**
 * runActor driver tests (Phase 53a).
 *
 * Covers:
 *   - kill-switch halts before observe
 *   - budget.maxIterations halts cleanly
 *   - budget.deadline halts before the next iteration starts
 *   - convergence guard: same classification key twice without progress
 *   - policy deny short-circuits apply
 *   - policy escalate blocks apply and surfaces in the report
 *   - converged (reflect.done=true) terminates with status 'converged'
 *   - audit events fire per phase
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runActor } from '../../src/actors/run-actor.js';
import type { Actor, ActorContext } from '../../src/actors/actor.js';
import type {
  ActorAdapters,
  ActorAuditEvent,
  Classified,
  ProposedAction,
  Reflection,
} from '../../src/actors/types.js';
import type { AtomId, PrincipalId, Time } from '../../src/types.js';
import { samplePrincipal, sampleAtom } from '../fixtures.js';

interface StubAdapters extends ActorAdapters {
  readonly stub: { readonly name: 'stub'; readonly version: '0'; };
}

const STUB: StubAdapters = {
  stub: { name: 'stub', version: '0' },
};

class ScriptedActor implements Actor<number, string, string, StubAdapters> {
  readonly name = 'scripted';
  readonly version = '0.1.0';
  constructor(
    private readonly opts: {
      observations: number[];
      classify?: (n: number, i: number) => Classified<number>;
      proposals?: ReadonlyArray<ProposedAction<string>>;
      reflect?: (i: number, outcomes: ReadonlyArray<string>) => Reflection;
      applyImpl?: (action: ProposedAction<string>) => Promise<string>;
    },
  ) {}

  async observe(ctx: ActorContext<StubAdapters>): Promise<number> {
    const idx = ctx.iteration - 1;
    if (idx >= this.opts.observations.length) return -1;
    return this.opts.observations[idx]!;
  }
  async classify(n: number, ctx: ActorContext<StubAdapters>): Promise<Classified<number>> {
    if (this.opts.classify) return this.opts.classify(n, ctx.iteration);
    return { observation: n, key: `k:${n}` };
  }
  async propose(): Promise<ReadonlyArray<ProposedAction<string>>> {
    return this.opts.proposals ?? [];
  }
  async apply(action: ProposedAction<string>): Promise<string> {
    if (this.opts.applyImpl) return this.opts.applyImpl(action);
    return `applied:${action.tool}`;
  }
  async reflect(outcomes: ReadonlyArray<string>, _c: Classified<number>, ctx: ActorContext<StubAdapters>): Promise<Reflection> {
    if (this.opts.reflect) return this.opts.reflect(ctx.iteration, outcomes);
    return { done: false, progress: outcomes.length > 0 };
  }
}

function policy(
  atomId: string,
  subject: 'tool-use',
  tool: string,
  action: 'allow' | 'deny' | 'escalate',
  overrides: Record<string, unknown> = {},
) {
  return sampleAtom({
    id: atomId as AtomId,
    type: 'directive',
    layer: 'L3',
    confidence: 1,
    metadata: {
      policy: {
        subject,
        tool,
        origin: '*',
        principal: '*',
        action,
        reason: `test:${action}:${tool}`,
        ...overrides,
      },
    },
  });
}

describe('runActor', () => {
  it('halts immediately when kill-switch is already true', async () => {
    const host = createMemoryHost();
    const actor = new ScriptedActor({ observations: [1, 2, 3] });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 5 },
      origin: 'test',
      killSwitch: () => true,
    });
    expect(report.haltReason).toBe('kill-switch');
    expect(report.iterations).toBe(1);
  });

  it('kill-switch triggered mid-iteration halts before the next apply (not at end)', async () => {
    // Contract per design/actors-and-adapters.md: killSwitch is checked
    // both at iteration start AND before each apply. When toggled on
    // between apply 1 and apply 2 of the same iteration, apply 2 must
    // not execute.
    const host = createMemoryHost();
    let killed = false;
    let applyCount = 0;
    const actor = new ScriptedActor({
      observations: [1],
      proposals: [
        { tool: 'safe-a', payload: 'a' },
        { tool: 'safe-b', payload: 'b' },
      ],
      applyImpl: async () => {
        applyCount++;
        if (applyCount === 1) killed = true; // flip the switch after first apply
        return `ok-${applyCount}`;
      },
      reflect: () => ({ done: false, progress: true }),
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 3 },
      origin: 'test',
      killSwitch: () => killed,
    });
    expect(applyCount).toBe(1);
    expect(report.haltReason).toBe('kill-switch');
  });

  it('halts when deadline passed before iteration start', async () => {
    const host = createMemoryHost();
    const actor = new ScriptedActor({ observations: [1, 2, 3] });
    const past = '2020-01-01T00:00:00.000Z' as Time;
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 5, deadline: past },
      origin: 'test',
    });
    expect(report.haltReason).toBe('budget-deadline');
  });

  it('exhausts maxIterations when reflect never signals done', async () => {
    const host = createMemoryHost();
    const actor = new ScriptedActor({
      observations: [1, 2, 3, 4, 5],
      classify: (n) => ({ observation: n, key: `k:${n}` }),
      reflect: () => ({ done: false, progress: true }),
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 3 },
      origin: 'test',
    });
    expect(report.haltReason).toBe('budget-iterations');
    expect(report.iterations).toBe(3);
  });

  it('converges when reflect returns done:true', async () => {
    const host = createMemoryHost();
    const actor = new ScriptedActor({
      observations: [1, 2],
      reflect: (i) => ({ done: i === 2, progress: true }),
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 5 },
      origin: 'test',
    });
    expect(report.haltReason).toBe('converged');
    expect(report.iterations).toBe(2);
  });

  it('halts on convergence-loop when same key repeats without progress', async () => {
    const host = createMemoryHost();
    const actor = new ScriptedActor({
      observations: [1, 1, 1],
      classify: () => ({ observation: 1, key: 'stuck' }),
      reflect: () => ({ done: false, progress: false }),
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 10 },
      origin: 'test',
    });
    expect(report.haltReason).toBe('convergence-loop');
    expect(report.escalations[0]).toContain('convergence');
  });

  it('policy deny: skips apply but continues loop', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policy('p1', 'tool-use', 'banned-tool', 'deny'));

    let applyCalls = 0;
    const actor = new ScriptedActor({
      observations: [1, 2],
      proposals: [{ tool: 'banned-tool', payload: 'x' }],
      applyImpl: async () => { applyCalls++; return 'ok'; },
      reflect: (i) => ({ done: i === 2, progress: false }),
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 5 },
      origin: 'test',
    });
    expect(applyCalls).toBe(0);
    expect(report.escalations.some((e) => e.startsWith('deny:'))).toBe(true);
    expect(report.haltReason).toBe('converged');
  });

  it('policy escalate: blocks apply and halts with policy-escalate-blocking', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policy('p2', 'tool-use', 'risky-tool', 'escalate'));

    let applyCalls = 0;
    const actor = new ScriptedActor({
      observations: [1],
      proposals: [{ tool: 'risky-tool', payload: 'x' }],
      applyImpl: async () => { applyCalls++; return 'ok'; },
      reflect: () => ({ done: false, progress: false }),
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 5 },
      origin: 'test',
    });
    expect(applyCalls).toBe(0);
    expect(report.haltReason).toBe('policy-escalate-blocking');
    expect(report.escalations.some((e) => e.startsWith('escalate:'))).toBe(true);
  });

  it('emits audit events for each phase when onAudit is provided', async () => {
    const host = createMemoryHost();
    const events: ActorAuditEvent[] = [];
    const actor = new ScriptedActor({
      observations: [1],
      proposals: [{ tool: 'safe-tool', payload: 'x' }],
      reflect: () => ({ done: true, progress: true }),
    });

    await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 2 },
      origin: 'test',
      onAudit: async (ev) => { events.push(ev); },
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('iteration-start');
    expect(kinds).toContain('observation');
    expect(kinds).toContain('classification');
    expect(kinds).toContain('proposal');
    expect(kinds).toContain('policy-decision');
    expect(kinds).toContain('apply-outcome');
    expect(kinds).toContain('reflection');
    expect(kinds).toContain('halt');
  });

  it('default policy allow: apply runs', async () => {
    const host = createMemoryHost();
    let applyCalls = 0;
    const actor = new ScriptedActor({
      observations: [1],
      proposals: [{ tool: 'fresh-tool', payload: 'x' }],
      applyImpl: async () => { applyCalls++; return 'done'; },
      reflect: () => ({ done: true, progress: true }),
    });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 5 },
      origin: 'test',
    });
    expect(applyCalls).toBe(1);
    expect(report.haltReason).toBe('converged');
    expect(report.escalations).toHaveLength(0);
  });
});
