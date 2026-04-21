/**
 * Tests for the operator-escalation helper.
 *
 * Guards three shipping behaviors:
 *   1. shouldEscalate rules match the three intended triggers
 *      (non-converged halt, any escalations, any body-nits).
 *   2. sendOperatorEscalation writes one and only one actor-message
 *      atom, addressed to the operator principal, with the PR link,
 *      halt reason, and any body-nits rendered inline.
 *   3. Proposed-fix diffs carried on comments surface as fenced
 *      diff blocks in the message body (the "copy into git apply"
 *      ergonomics from fix 3B).
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  sendOperatorEscalation,
  shouldEscalate,
} from '../../src/actor-message/operator-escalation.js';
import type { ActorReport } from '../../src/actors/types.js';
import type { ReviewComment } from '../../src/actors/pr-review/adapter.js';
import type { PrincipalId, Time } from '../../src/types.js';

function mkReport(over: Partial<ActorReport> = {}): ActorReport {
  return {
    actor: 'pr-landing',
    principal: 'pr-landing-agent' as PrincipalId,
    haltReason: 'converged',
    iterations: 1,
    startedAt: '2026-04-20T19:00:00.000Z' as Time,
    endedAt: '2026-04-20T19:00:02.000Z' as Time,
    escalations: [],
    ...over,
  };
}

function mkLineComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    author: 'coderabbitai[bot]',
    body: '**Sample finding.**\n\nLong body.',
    createdAt: '2026-04-20T19:00:00.000Z',
    resolved: false,
    path: 'src/foo.ts',
    line: 42,
    kind: 'line',
    ...over,
  };
}

function mkBodyNit(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'body-nit:1:src/bar.ts:10',
    author: 'coderabbitai[bot]',
    body: 'Minor wording suggestion.',
    createdAt: '2026-04-20T19:00:00.000Z',
    resolved: false,
    path: 'src/bar.ts',
    line: 10,
    kind: 'body-nit',
    severity: 'nit',
    ...over,
  };
}

describe('shouldEscalate', () => {
  it('does NOT escalate on a clean converged run with no body-nits', () => {
    expect(shouldEscalate(mkReport(), { bodyNits: [] })).toBe(false);
  });

  it('escalates when haltReason is anything other than converged', () => {
    expect(shouldEscalate(mkReport({ haltReason: 'convergence-loop' }))).toBe(true);
    expect(shouldEscalate(mkReport({ haltReason: 'budget-iterations' }))).toBe(true);
    expect(shouldEscalate(mkReport({ haltReason: 'error' }))).toBe(true);
  });

  it('escalates when the report carries any escalations, even if converged', () => {
    expect(
      shouldEscalate(mkReport({ escalations: ['policy escalated x'] })),
    ).toBe(true);
  });

  it('escalates when body-nits are present, even if converged with no escalations', () => {
    expect(
      shouldEscalate(mkReport(), { bodyNits: [mkBodyNit()] }),
    ).toBe(true);
  });
});

describe('sendOperatorEscalation', () => {
  it('writes one actor-message atom to the operator principal with halt metadata', async () => {
    const host = createMemoryHost();
    const report = mkReport({
      haltReason: 'convergence-loop',
      escalations: ['convergence: nit:0 suggestion:2 architectural:0'],
    });

    const outcome = await sendOperatorEscalation({
      host,
      report,
      pr: { owner: 'o', repo: 'r', number: 48, title: 'feat: bot identity' },
      origin: 'github-action',
      observation: { comments: [], bodyNits: [] },
      now: () => Date.parse('2026-04-20T19:56:36.000Z'),
    });
    expect(outcome.alreadyExisted).toBe(false);

    const { atoms } = await host.atoms.query({ type: ['actor-message'] }, 10);
    expect(atoms.length).toBe(1);
    const atom = atoms[0]!;
    expect(atom.id).toBe(outcome.atomId);
    expect(atom.principal_id).toBe('pr-landing-agent');

    const env = atom.metadata?.actor_message as Record<string, unknown>;
    expect(env.to).toBe('operator');
    expect(env.from).toBe('pr-landing-agent');
    expect(env.topic).toBe('actor-halt:pr-landing:o/r#48');

    expect(atom.content).toContain('pr-landing halt on o/r#48');
    expect(atom.content).toContain('`convergence-loop`');
    expect(atom.content).toContain('https://github.com/o/r/pull/48');
    expect(atom.content).toContain(
      '- convergence: nit:0 suggestion:2 architectural:0',
    );

    const esc = atom.metadata?.escalation as Record<string, unknown>;
    expect(esc.halt_reason).toBe('convergence-loop');
    expect(esc.iterations).toBe(1);
  });

  it('renders unresolved line comments and body-nits under separate headings', async () => {
    const host = createMemoryHost();
    const lineC = mkLineComment({
      id: 'L1',
      body: '**Actionable on line 42.**\n\nReason.',
      path: 'src/a.ts',
      line: 42,
    });
    const bodyN = mkBodyNit({
      id: 'body-nit:99:src/b.ts:7',
      body: '**Minor wording.**',
      path: 'src/b.ts',
      line: 7,
    });

    await sendOperatorEscalation({
      host,
      report: mkReport({ haltReason: 'convergence-loop' }),
      pr: { owner: 'o', repo: 'r', number: 1 },
      observation: { comments: [lineC], bodyNits: [bodyN] },
    });

    const { atoms } = await host.atoms.query({ type: ['actor-message'] }, 10);
    const content = atoms[0]!.content;
    expect(content).toMatch(/## Unresolved line comments \(1\)/);
    expect(content).toMatch(/`src\/a\.ts`:42/);
    expect(content).toMatch(/Actionable on line 42\./);
    expect(content).toMatch(/## Body-scoped nits \(1\)/);
    expect(content).toMatch(/`src\/b\.ts`:7/);
    expect(content).toMatch(/Minor wording\./);
  });

  it('inlines proposed-fix diffs from comments as fenced diff blocks', async () => {
    const host = createMemoryHost();
    const diff = `- const x = 1;\n+ const x = 2;`;
    const lineC = mkLineComment({
      id: 'L1',
      body: '**Fix suggestion.**',
      proposedFix: diff,
    });

    await sendOperatorEscalation({
      host,
      report: mkReport({ haltReason: 'convergence-loop' }),
      pr: { owner: 'o', repo: 'r', number: 1 },
      observation: { comments: [lineC], bodyNits: [] },
    });

    const { atoms } = await host.atoms.query({ type: ['actor-message'] }, 10);
    const content = atoms[0]!.content;
    expect(content).toContain('```diff');
    expect(content).toContain('- const x = 1;');
    expect(content).toContain('+ const x = 2;');
  });

  it('produces a deterministic atom id so repeat sends are idempotent + signals alreadyExisted', async () => {
    const host = createMemoryHost();
    const ctx = {
      host,
      report: mkReport({ haltReason: 'convergence-loop', iterations: 2 }),
      pr: { owner: 'o', repo: 'r', number: 48 },
    };

    const outA = await sendOperatorEscalation(ctx);
    const outB = await sendOperatorEscalation(ctx);
    expect(outA.atomId).toBe(outB.atomId);
    // First call writes; second call is a dedup. This is the signal
    // run-pr-landing uses to skip a duplicate PR comment post on
    // repeat runs for the same halt.
    expect(outA.alreadyExisted).toBe(false);
    expect(outB.alreadyExisted).toBe(true);

    const { atoms } = await host.atoms.query({ type: ['actor-message'] }, 10);
    // ConflictError is swallowed on the second put, so exactly one
    // atom exists in the store.
    expect(atoms.length).toBe(1);
  });

  it('tolerates missing observation and omits the items sections', async () => {
    const host = createMemoryHost();
    await sendOperatorEscalation({
      host,
      report: mkReport({ haltReason: 'convergence-loop' }),
      pr: { owner: 'o', repo: 'r', number: 1 },
    });

    const { atoms } = await host.atoms.query({ type: ['actor-message'] }, 10);
    const content = atoms[0]!.content;
    expect(content).not.toMatch(/## Unresolved line comments/);
    expect(content).not.toMatch(/## Body-scoped nits/);
    expect(content).toContain('convergence-loop');
  });

  it('uses a custom operator principal when provided', async () => {
    const host = createMemoryHost();
    await sendOperatorEscalation({
      host,
      report: mkReport({ haltReason: 'convergence-loop' }),
      pr: { owner: 'o', repo: 'r', number: 1 },
      operator: 'stephen-human' as PrincipalId,
    });

    const { atoms } = await host.atoms.query({ type: ['actor-message'] }, 10);
    const env = atoms[0]!.metadata?.actor_message as Record<string, unknown>;
    expect(env.to).toBe('stephen-human');
  });
});
