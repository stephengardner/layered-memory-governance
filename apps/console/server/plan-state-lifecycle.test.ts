import { describe, expect, it } from 'vitest';
import {
  buildPlanStateLifecycle,
  type PlanAtomSlice,
} from './plan-state-lifecycle';

/*
 * Unit coverage for the plan_state lifecycle projection. Each test
 * pins one observable property of the four-step output (proposed ->
 * approved -> executing -> terminal) so a regression in either the
 * dispatcher's metadata stamps or this projection surfaces a single
 * failing assertion rather than a cascading mismatch.
 */

const PLAN_ID = 'plan-test-fixture';
const PROPOSER = 'cto-actor';
const PROPOSED_AT = '2026-04-30T10:00:00.000Z';
const APPROVED_AT = '2026-04-30T10:01:00.000Z';
const EXECUTING_AT = '2026-04-30T10:02:00.000Z';
const TERMINAL_AT = '2026-04-30T10:05:00.000Z';
const INVOKER = 'code-author';

function fixture(opts: {
  plan_state?: string | null;
  metadata?: Record<string, unknown>;
} = {}): PlanAtomSlice {
  return {
    id: PLAN_ID,
    created_at: PROPOSED_AT,
    principal_id: PROPOSER,
    plan_state: opts.plan_state ?? 'proposed',
    metadata: opts.metadata ?? {},
  };
}

describe('buildPlanStateLifecycle', () => {
  describe('proposed-only plan (no approval)', () => {
    const lifecycle = buildPlanStateLifecycle(fixture({ plan_state: 'proposed' }));

    it('returns exactly four steps in fixed order', () => {
      expect(lifecycle.steps).toHaveLength(4);
      expect(lifecycle.steps.map((s) => s.kind)).toEqual([
        'proposed',
        'approved',
        'executing',
        'terminal',
      ]);
    });

    it('marks proposed reached with the plan principal + created_at', () => {
      const proposed = lifecycle.steps[0]!;
      expect(proposed.status).toBe('reached');
      expect(proposed.at).toBe(PROPOSED_AT);
      expect(proposed.by).toBe(PROPOSER);
      expect(proposed.terminal_kind).toBeNull();
      expect(proposed.error_message).toBeNull();
    });

    it('marks approved/executing/terminal as pending with no timestamps', () => {
      for (const kind of ['approved', 'executing', 'terminal'] as const) {
        const step = lifecycle.steps.find((s) => s.kind === kind)!;
        expect(step.status, `${kind} should be pending`).toBe('pending');
        expect(step.at, `${kind}.at should be null`).toBeNull();
        expect(step.by, `${kind}.by should be null`).toBeNull();
        expect(step.terminal_kind).toBeNull();
        expect(step.error_message).toBeNull();
      }
    });
  });

  describe('approved-only plan (waiting on dispatch)', () => {
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'approved',
      metadata: { approved_at: APPROVED_AT },
    }));

    it('marks approved reached and stamps the timestamp', () => {
      const approved = lifecycle.steps.find((s) => s.kind === 'approved')!;
      expect(approved.status).toBe('reached');
      expect(approved.at).toBe(APPROVED_AT);
    });

    it('leaves the by field on approved as null (no single approver in v0)', () => {
      const approved = lifecycle.steps.find((s) => s.kind === 'approved')!;
      expect(approved.by).toBeNull();
    });

    it('keeps executing + terminal pending', () => {
      const executing = lifecycle.steps.find((s) => s.kind === 'executing')!;
      const terminal = lifecycle.steps.find((s) => s.kind === 'terminal')!;
      expect(executing.status).toBe('pending');
      expect(terminal.status).toBe('pending');
    });
  });

  describe('executing plan (dispatched, awaiting terminal)', () => {
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'executing',
      metadata: {
        approved_at: APPROVED_AT,
        executing_at: EXECUTING_AT,
        executing_invoker: INVOKER,
      },
    }));

    it('marks proposed/approved/executing reached with their stamps', () => {
      const proposed = lifecycle.steps.find((s) => s.kind === 'proposed')!;
      const approved = lifecycle.steps.find((s) => s.kind === 'approved')!;
      const executing = lifecycle.steps.find((s) => s.kind === 'executing')!;
      expect(proposed.status).toBe('reached');
      expect(approved.status).toBe('reached');
      expect(approved.at).toBe(APPROVED_AT);
      expect(executing.status).toBe('reached');
      expect(executing.at).toBe(EXECUTING_AT);
      expect(executing.by).toBe(INVOKER);
    });

    it('keeps terminal pending', () => {
      const terminal = lifecycle.steps.find((s) => s.kind === 'terminal')!;
      expect(terminal.status).toBe('pending');
      expect(terminal.terminal_kind).toBeNull();
      expect(terminal.error_message).toBeNull();
    });
  });

  describe('succeeded plan (full happy-path lifecycle)', () => {
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'succeeded',
      metadata: {
        approved_at: APPROVED_AT,
        executing_at: EXECUTING_AT,
        executing_invoker: INVOKER,
        terminal_at: TERMINAL_AT,
        terminal_kind: 'succeeded',
      },
    }));

    it('marks every step reached', () => {
      for (const step of lifecycle.steps) {
        expect(step.status, `${step.kind} should be reached`).toBe('reached');
      }
    });

    it('terminal carries succeeded kind, no error_message', () => {
      const terminal = lifecycle.steps.find((s) => s.kind === 'terminal')!;
      expect(terminal.at).toBe(TERMINAL_AT);
      expect(terminal.terminal_kind).toBe('succeeded');
      expect(terminal.error_message).toBeNull();
      expect(terminal.by).toBe('plan-dispatcher');
    });
  });

  describe('failed plan with error_message', () => {
    const ERROR_MSG = 'sub-actor invoke failed: stage=cited-path-not-found: src/foo.ts not found';
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'failed',
      metadata: {
        approved_at: APPROVED_AT,
        executing_at: EXECUTING_AT,
        executing_invoker: INVOKER,
        terminal_at: TERMINAL_AT,
        terminal_kind: 'failed',
        error_message: ERROR_MSG,
      },
    }));

    it('terminal carries failed kind + error_message', () => {
      const terminal = lifecycle.steps.find((s) => s.kind === 'terminal')!;
      expect(terminal.status).toBe('reached');
      expect(terminal.terminal_kind).toBe('failed');
      expect(terminal.error_message).toBe(ERROR_MSG);
      expect(terminal.at).toBe(TERMINAL_AT);
    });

    it('keeps preceding reached steps populated', () => {
      const approved = lifecycle.steps.find((s) => s.kind === 'approved')!;
      const executing = lifecycle.steps.find((s) => s.kind === 'executing')!;
      expect(approved.status).toBe('reached');
      expect(executing.status).toBe('reached');
      expect(executing.by).toBe(INVOKER);
    });
  });

  describe('failed plan without approved_at (pre-approval halt)', () => {
    /*
     * A plan that hits 'failed' state but never had approved_at stamped
     * means the approval flow itself halted (envelope mismatch error,
     * intent expired between read and write, etc.). Approved should
     * read 'skipped' so the operator does not see a misleading "still
     * pending" state when the plan has already terminated upstream of
     * approval.
     */
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'failed',
      metadata: {
        terminal_at: TERMINAL_AT,
        terminal_kind: 'failed',
        error_message: 'approval-flow halted before envelope match',
      },
    }));

    it('marks approved as skipped (failed without approved_at is a pre-approval halt)', () => {
      const approved = lifecycle.steps.find((s) => s.kind === 'approved')!;
      expect(approved.status).toBe('skipped');
      expect(approved.at).toBeNull();
    });

    it('terminal still reaches with the failed kind + error_message', () => {
      const terminal = lifecycle.steps.find((s) => s.kind === 'terminal')!;
      expect(terminal.status).toBe('reached');
      expect(terminal.terminal_kind).toBe('failed');
    });
  });

  describe('failed plan WITH approved_at (post-approval failure)', () => {
    /*
     * A plan that hits 'failed' AFTER being approved should NOT have
     * approved rendered as skipped -- the approval step did happen.
     * This is the canonical failure path: dispatcher claims approved,
     * stamps executing_at, then registry.invoke errors out.
     */
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'failed',
      metadata: {
        approved_at: APPROVED_AT,
        executing_at: EXECUTING_AT,
        executing_invoker: INVOKER,
        terminal_at: TERMINAL_AT,
        terminal_kind: 'failed',
        error_message: 'sub-actor crashed',
      },
    }));

    it('approved stays reached even though plan_state is failed', () => {
      const approved = lifecycle.steps.find((s) => s.kind === 'approved')!;
      expect(approved.status).toBe('reached');
      expect(approved.at).toBe(APPROVED_AT);
    });
  });

  describe('rejected plan (terminated before approval)', () => {
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'rejected',
      metadata: {},
    }));

    it('marks approved as skipped (not pending) so the row reads honestly', () => {
      const approved = lifecycle.steps.find((s) => s.kind === 'approved')!;
      expect(approved.status).toBe('skipped');
      expect(approved.at).toBeNull();
    });

    it('keeps executing pending because terminal_at is absent and rejected is not in TERMINAL_STATES', () => {
      const executing = lifecycle.steps.find((s) => s.kind === 'executing')!;
      // Without terminal_at and without TERMINAL_STATES membership for
      // 'rejected' the executing step renders as pending today; this
      // test pins the documented behaviour: the projection treats
      // 'rejected' as a pre-approval skip but does NOT reach into
      // dispatch. The terminal itself stays pending because rejected
      // is recorded by the policy gate, not by plan-dispatcher.
      expect(executing.status).toBe('pending');
    });
  });

  describe('legacy plan: succeeded state but no #270 metadata stamps', () => {
    /*
     * Pre-PR-#270 atoms do not carry approved_at / executing_at /
     * terminal_at. The projection still reaches terminal via the
     * plan_state fallback so the row paints with the right tone; the
     * timestamps stay null and the UI renders an em-dash ("not stamped")
     * rather than a fake date.
     */
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'succeeded',
      metadata: {},
    }));

    it('reaches terminal via plan_state fallback even with empty metadata', () => {
      const terminal = lifecycle.steps.find((s) => s.kind === 'terminal')!;
      expect(terminal.status).toBe('reached');
      expect(terminal.terminal_kind).toBe('succeeded');
      expect(terminal.at).toBeNull();
    });

    it('approved stays pending and executing renders skipped on legacy succeeded atoms', () => {
      const approved = lifecycle.steps.find((s) => s.kind === 'approved')!;
      const executing = lifecycle.steps.find((s) => s.kind === 'executing')!;
      // Approved without approved_at and without rejected/abandoned
      // state stays pending; that's a known limitation for legacy
      // succeeded atoms missing the approval stamp. The terminal row
      // carrying 'succeeded' is enough for the operator to know the
      // plan reached terminal; approval staying pending is the
      // projection signaling the metadata is missing rather than
      // fabricating a date.
      expect(approved.status).toBe('pending');
      expect(executing.status).toBe('skipped');
    });
  });

  describe('failed plan refuses to surface error_message on a succeeded terminal', () => {
    /*
     * Defensive: a malformed atom carrying terminal_kind='succeeded'
     * AND error_message MUST NOT show the message in the UI. The
     * dispatcher never writes that pair, but a hand-edited atom
     * could; the projection drops the message.
     */
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'succeeded',
      metadata: {
        terminal_at: TERMINAL_AT,
        terminal_kind: 'succeeded',
        error_message: 'stale message that should never render',
      },
    }));

    it('terminal does not surface error_message when terminal_kind is succeeded', () => {
      const terminal = lifecycle.steps.find((s) => s.kind === 'terminal')!;
      expect(terminal.terminal_kind).toBe('succeeded');
      expect(terminal.error_message).toBeNull();
    });
  });

  describe('garbage terminal_kind collapses to null but plan_state fallback applies', () => {
    const lifecycle = buildPlanStateLifecycle(fixture({
      plan_state: 'failed',
      metadata: {
        terminal_at: TERMINAL_AT,
        terminal_kind: 'totally-not-a-real-kind',
        error_message: 'real message',
      },
    }));

    it('terminal_kind defaults to plan_state when raw value is unknown', () => {
      const terminal = lifecycle.steps.find((s) => s.kind === 'terminal')!;
      expect(terminal.terminal_kind).toBe('failed');
      expect(terminal.error_message).toBe('real message');
    });
  });
});
