import { describe, it, expect, vi } from 'vitest';

/*
 * The dispatch.ts module imports renderer .tsx files which require
 * react/jsx-runtime at module-load time. Vitest runs in `node`
 * environment per the existing vitest.config.ts; loading the renderer
 * tree there fails on the JSX runtime resolution. The fix is to mock
 * out every renderer module with a sentinel function so we can still
 * assert the dispatch SHAPE (which name resolves to which renderer)
 * without ever evaluating any React component code.
 *
 * Test contract: the table is a stable identity-mapping. Given a type
 * name, pickRenderer returns the renderer registered for that name
 * (and the generic fallback otherwise). Renderer COMPONENT correctness
 * is tested by Playwright e2e (live render against a real atom);
 * dispatch correctness is unit-tested here.
 */

vi.mock('./generic', () => ({
  GenericRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./plan', () => ({
  PlanRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./pipeline', () => ({
  PipelineRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./pipeline-stage-event', () => ({
  PipelineStageEventRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./pipeline-audit-finding', () => ({
  PipelineAuditFindingRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./brainstorm-output', () => ({
  BrainstormOutputRenderer: () => null as unknown as JSX.Element,
  SpecOutputRenderer: () => null as unknown as JSX.Element,
  ReviewReportRenderer: () => null as unknown as JSX.Element,
  DispatchRecordRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./operator-intent', () => ({
  OperatorIntentRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./actor-message', () => ({
  ActorMessageRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./auditor-plan-check', () => ({
  AuditorPlanCheckRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./agent-session', () => ({
  AgentSessionRenderer: () => null as unknown as JSX.Element,
  AgentTurnRenderer: () => null as unknown as JSX.Element,
}));
vi.mock('./pr-fix-observation', () => ({
  PrFixObservationRenderer: () => null as unknown as JSX.Element,
}));

const { pickRenderer, _internal } = await import('./dispatch');
const { GenericRenderer } = await import('./generic');
const { PlanRenderer } = await import('./plan');
const { PipelineRenderer } = await import('./pipeline');
const { PipelineStageEventRenderer } = await import('./pipeline-stage-event');
const { PipelineAuditFindingRenderer } = await import('./pipeline-audit-finding');
const {
  BrainstormOutputRenderer,
  SpecOutputRenderer,
  ReviewReportRenderer,
  DispatchRecordRenderer,
} = await import('./brainstorm-output');
const { OperatorIntentRenderer } = await import('./operator-intent');
const { ActorMessageRenderer } = await import('./actor-message');
const { AuditorPlanCheckRenderer } = await import('./auditor-plan-check');
const { AgentSessionRenderer, AgentTurnRenderer } = await import('./agent-session');
const { PrFixObservationRenderer } = await import('./pr-fix-observation');

describe('pickRenderer', () => {
  describe('type-specific dispatch', () => {
    it.each([
      ['plan', PlanRenderer],
      ['pipeline', PipelineRenderer],
      ['pipeline-stage-event', PipelineStageEventRenderer],
      ['pipeline-audit-finding', PipelineAuditFindingRenderer],
      ['pipeline-resume', PipelineStageEventRenderer],
      ['pipeline-failed', PipelineStageEventRenderer],
      ['brainstorm-output', BrainstormOutputRenderer],
      ['spec-output', SpecOutputRenderer],
      ['review-report', ReviewReportRenderer],
      ['dispatch-record', DispatchRecordRenderer],
      ['operator-intent', OperatorIntentRenderer],
      ['actor-message', ActorMessageRenderer],
      ['actor-message-ack', ActorMessageRenderer],
      ['agent-session', AgentSessionRenderer],
      ['agent-turn', AgentTurnRenderer],
      ['pr-fix-observation', PrFixObservationRenderer],
    ])('routes %s atoms to the right renderer', (type, expected) => {
      expect(pickRenderer(type as string)).toBe(expected);
    });
  });

  describe('observation kind disambiguation', () => {
    it('routes observation atoms with metadata.kind=auditor-plan-check to AuditorPlanCheckRenderer', () => {
      const r = pickRenderer('observation', { kind: 'auditor-plan-check' });
      expect(r).toBe(AuditorPlanCheckRenderer);
    });

    it('routes observation atoms with metadata.kind=pr-observation to PrFixObservationRenderer', () => {
      const r = pickRenderer('observation', { kind: 'pr-observation' });
      expect(r).toBe(PrFixObservationRenderer);
    });

    it('routes observation atoms with unknown metadata.kind to GenericRenderer', () => {
      const r = pickRenderer('observation', { kind: 'mystery-kind' });
      expect(r).toBe(GenericRenderer);
    });

    it('routes observation atoms with no metadata to GenericRenderer', () => {
      const r = pickRenderer('observation');
      expect(r).toBe(GenericRenderer);
    });

    it('routes observation atoms with metadata but no kind field to GenericRenderer', () => {
      const r = pickRenderer('observation', { other: 'field' });
      expect(r).toBe(GenericRenderer);
    });
  });

  describe('fallbacks', () => {
    it('routes unknown atom types to GenericRenderer', () => {
      expect(pickRenderer('mystery-future-type')).toBe(GenericRenderer);
    });

    it('routes empty type to GenericRenderer', () => {
      expect(pickRenderer('')).toBe(GenericRenderer);
    });

    it('routes undefined type to GenericRenderer', () => {
      expect(pickRenderer(undefined)).toBe(GenericRenderer);
    });
  });

  describe('table coverage invariants', () => {
    it('every entry in TYPE_RENDERERS is a function (renderer component)', () => {
      for (const [type, renderer] of Object.entries(_internal.TYPE_RENDERERS)) {
        expect(typeof renderer).toBe('function');
        expect(type.length).toBeGreaterThan(0);
      }
    });

    it('every entry in OBSERVATION_KIND_RENDERERS is a function', () => {
      for (const [kind, renderer] of Object.entries(_internal.OBSERVATION_KIND_RENDERERS)) {
        expect(typeof renderer).toBe('function');
        expect(kind.length).toBeGreaterThan(0);
      }
    });

    /*
     * The required-coverage list. If a future PR adds a new
     * substrate atom type that's high-volume enough to warrant a
     * dedicated renderer, extend this list AND the dispatch table.
     */
    const REQUIRED_TYPES = [
      'plan',
      'pipeline',
      'pipeline-stage-event',
      'pipeline-audit-finding',
      'brainstorm-output',
      'spec-output',
      'review-report',
      'dispatch-record',
      'operator-intent',
      'actor-message',
      'actor-message-ack',
      'agent-session',
      'agent-turn',
      'pr-fix-observation',
    ];

    it.each(REQUIRED_TYPES)('required type %s has a dedicated renderer (not GenericRenderer)', (type) => {
      const r = pickRenderer(type);
      expect(r).not.toBe(GenericRenderer);
    });
  });
});
