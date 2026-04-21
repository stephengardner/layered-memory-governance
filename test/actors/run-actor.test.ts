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

  it('halts immediately when killSwitchSignal is already aborted', async () => {
    const host = createMemoryHost();
    const ac = new AbortController();
    ac.abort();
    const actor = new ScriptedActor({ observations: [1, 2, 3] });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 5 },
      origin: 'test',
      killSwitchSignal: ac.signal,
    });
    expect(report.haltReason).toBe('kill-switch');
    expect(report.iterations).toBe(1);
  });

  it('killSwitchSignal aborted mid-iteration halts before next apply', async () => {
    // Medium-tier contract: when the signal aborts between action N
    // and action N+1 of the same iteration, action N+1 must not run.
    // Matches the cooperative-tear-down promise of the
    // arch-medium-tier-kill-switch ADR.
    const host = createMemoryHost();
    const ac = new AbortController();
    let applyCount = 0;
    const actor = new ScriptedActor({
      observations: [1],
      proposals: [
        { tool: 'safe-a', payload: 'a' },
        { tool: 'safe-b', payload: 'b' },
      ],
      applyImpl: async () => {
        applyCount++;
        if (applyCount === 1) ac.abort();
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
      killSwitchSignal: ac.signal,
    });
    expect(applyCount).toBe(1);
    expect(report.haltReason).toBe('kill-switch');
  });

  it('ctx.abortSignal is always present (never-aborted default when no option supplied)', async () => {
    // Back-compat contract: adapters can thread ctx.abortSignal
    // unconditionally without null-checking, even on soft-path
    // invocations that did not supply killSwitchSignal.
    const host = createMemoryHost();
    let seen: AbortSignal | null = null;
    class SignalPeekActor extends ScriptedActor {
      override async observe(ctx: ActorContext<StubAdapters>): Promise<number> {
        seen = ctx.abortSignal;
        return super.observe(ctx);
      }
    }
    const actor = new SignalPeekActor({
      observations: [1],
      reflect: () => ({ done: true, progress: true }),
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 1 },
      origin: 'test',
    });
    expect(seen).not.toBe(null);
    expect(seen!.aborted).toBe(false);
  });

  it('ctx.abortSignal forwards the supplied killSwitchSignal instance', async () => {
    // Contract: when killSwitchSignal is supplied, ctx.abortSignal
    // IS that signal (same referential identity) so downstream
    // adapters composing on top of AbortSignal.any() see the same
    // upstream source.
    const host = createMemoryHost();
    const ac = new AbortController();
    let seen: AbortSignal | null = null;
    class SignalPeekActor extends ScriptedActor {
      override async observe(ctx: ActorContext<StubAdapters>): Promise<number> {
        seen = ctx.abortSignal;
        return super.observe(ctx);
      }
    }
    const actor = new SignalPeekActor({
      observations: [1],
      reflect: () => ({ done: true, progress: true }),
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 1 },
      origin: 'test',
      killSwitchSignal: ac.signal,
    });
    expect(seen).toBe(ac.signal);
  });

  it('killSwitch predicate AND killSwitchSignal: either halts', async () => {
    // Back-compat: both forms are simultaneously valid. First trip
    // wins.
    const host = createMemoryHost();
    const ac = new AbortController();
    // Signal never aborts; predicate wins.
    {
      const actor = new ScriptedActor({ observations: [1, 2, 3] });
      const report = await runActor(actor, {
        host,
        principal: samplePrincipal(),
        adapters: STUB,
        budget: { maxIterations: 5 },
        origin: 'test',
        killSwitch: () => true,
        killSwitchSignal: ac.signal,
      });
      expect(report.haltReason).toBe('kill-switch');
    }
    // Predicate never fires; signal wins.
    {
      const ac2 = new AbortController();
      ac2.abort();
      const actor = new ScriptedActor({ observations: [1, 2, 3] });
      const report = await runActor(actor, {
        host,
        principal: samplePrincipal(),
        adapters: STUB,
        budget: { maxIterations: 5 },
        origin: 'test',
        killSwitch: () => false,
        killSwitchSignal: ac2.signal,
      });
      expect(report.haltReason).toBe('kill-switch');
    }
  });

  it('writes a kill-switch-tripped atom on trip (metadata.kind discriminator)', async () => {
    // Contract per arch-medium-tier-kill-switch: on a kill-switch
    // halt the runner emits a durable L1 observation with
    // metadata.kind='kill-switch-tripped' carrying actor, principal,
    // trigger, phase, iteration, and session_id for lineage.
    const host = createMemoryHost();
    const actor = new ScriptedActor({ observations: [1, 2, 3] });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 5 },
      origin: 'test',
      killSwitch: () => true,
      killSwitchSessionId: 'test-session-abc',
    });
    expect(report.haltReason).toBe('kill-switch');
    const { atoms } = await host.atoms.query({}, 100);
    const tripped = atoms.find(
      (a) => (a.metadata as { kind?: unknown } | null | undefined)?.kind === 'kill-switch-tripped',
    );
    expect(tripped).toBeDefined();
    expect(tripped!.type).toBe('observation');
    expect(tripped!.layer).toBe('L1');
    expect(tripped!.metadata).toMatchObject({
      kind: 'kill-switch-tripped',
      actor: 'scripted',
      tripped_by: 'stop-sentinel',
      phase: 'between-iterations',
    });
    expect(tripped!.provenance.source.session_id).toBe('test-session-abc');
    expect(tripped!.provenance.source.tool).toBe('kill-switch-revocation');
  });

  it('kill-switch-tripped atom records phase=apply and in_flight_tool when mid-action', async () => {
    // Halt mid-iteration, after apply N, before apply N+1. The
    // atom must record phase='apply' and the tool of the action
    // that WAS about to run (action N+1). This is the audit
    // information a reviewer needs to reconstruct "where was the
    // actor when the operator pulled the plug."
    const host = createMemoryHost();
    let killed = false;
    let applyCount = 0;
    const actor = new ScriptedActor({
      observations: [1],
      proposals: [
        { tool: 'safe-a', payload: 'a' },
        { tool: 'danger-b', payload: 'b' },
      ],
      applyImpl: async () => {
        applyCount++;
        if (applyCount === 1) killed = true;
        return `ok-${applyCount}`;
      },
      reflect: () => ({ done: false, progress: true }),
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 3 },
      origin: 'test',
      killSwitch: () => killed,
      killSwitchSessionId: 'test-session-mid',
    });
    const { atoms } = await host.atoms.query({}, 100);
    const tripped = atoms.find(
      (a) => (a.metadata as { kind?: unknown } | null | undefined)?.kind === 'kill-switch-tripped',
    );
    expect(tripped).toBeDefined();
    expect(tripped!.metadata).toMatchObject({
      kind: 'kill-switch-tripped',
      phase: 'apply',
      in_flight_tool: 'danger-b',
    });
  });

  it('no kill-switch-tripped atom on non-kill-switch halts', async () => {
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
    const { atoms } = await host.atoms.query({}, 100);
    const tripped = atoms.find(
      (a) => (a.metadata as { kind?: unknown } | null | undefined)?.kind === 'kill-switch-tripped',
    );
    expect(tripped).toBeUndefined();
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

  it('error in classify halts with haltReason=error and a descriptive note', async () => {
    const host = createMemoryHost();
    class BrokenClassify extends ScriptedActor {
      override async classify(): Promise<never> {
        throw new Error('classify-kaboom');
      }
    }
    const actor = new BrokenClassify({ observations: [1] });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 3 },
      origin: 'test',
    });
    expect(report.haltReason).toBe('error');
    expect(report.lastNote).toMatch(/classify failed: classify-kaboom/);
  });

  it('error in propose halts with haltReason=error', async () => {
    const host = createMemoryHost();
    class BrokenPropose extends ScriptedActor {
      override async propose(): Promise<never> {
        throw new Error('propose-kaboom');
      }
    }
    const actor = new BrokenPropose({ observations: [1] });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 3 },
      origin: 'test',
    });
    expect(report.haltReason).toBe('error');
    expect(report.lastNote).toMatch(/propose failed: propose-kaboom/);
  });

  it('error in reflect halts with haltReason=error', async () => {
    const host = createMemoryHost();
    class BrokenReflect extends ScriptedActor {
      override async reflect(): Promise<never> {
        throw new Error('reflect-kaboom');
      }
    }
    const actor = new BrokenReflect({
      observations: [1],
      proposals: [{ tool: 'safe', payload: 'x' }],
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: STUB,
      budget: { maxIterations: 3 },
      origin: 'test',
    });
    expect(report.haltReason).toBe('error');
    expect(report.lastNote).toMatch(/reflect failed: reflect-kaboom/);
  });
});
