import { describe, it, expect } from 'vitest';
import {
  classifyOperatorAction,
  clampLimit,
  deriveArgsPreview,
  deriveTarget,
  listOperatorActions,
} from './operator-actions';
import type { OperatorActionSourceAtom } from './operator-actions-types';
import {
  OPERATOR_ACTIONS_DEFAULT_LIMIT,
  OPERATOR_ACTIONS_MAX_LIST_ITEMS,
} from './operator-actions-types';

/*
 * Pure-function tests for the operator-actions projection helpers. The
 * server's HTTP route is a thin wrapper around these; if these pass and
 * the route handler delegates correctly, the read + classify + filter
 * logic has full coverage without standing up a socket.
 *
 * Determinism: every test pins `now` explicitly so no system clock
 * dependency creeps in. Source atoms are constructed with the same
 * envelope shape `scripts/gh-as.mjs` writes (id prefix `op-action-`,
 * type 'observation', metadata.operator_action).
 */

const NOW = Date.parse('2026-05-10T12:00:00.000Z');

function actionAtom(opts: {
  id: string;
  actor: string;
  createdAt: string;
  args: ReadonlyArray<string>;
  sessionId?: string;
  taint?: string;
  superseded?: boolean;
  malformed?: boolean;
}): OperatorActionSourceAtom {
  if (opts.malformed) {
    return {
      id: opts.id,
      type: 'observation',
      layer: 'L1',
      content: `malformed ${opts.id}`,
      principal_id: opts.actor,
      created_at: opts.createdAt,
      taint: opts.taint ?? 'clean',
      superseded_by: opts.superseded ? ['next'] : [],
      metadata: { /* no operator_action envelope */ },
    };
  }
  return {
    id: opts.id,
    type: 'observation',
    layer: 'L1',
    content: `${opts.actor}: gh ${JSON.stringify(opts.args)}`,
    principal_id: opts.actor,
    created_at: opts.createdAt,
    taint: opts.taint ?? 'clean',
    superseded_by: opts.superseded ? ['next'] : [],
    metadata: {
      operator_action: {
        role: opts.actor,
        args: opts.args,
        started_at: opts.createdAt,
        session_id: opts.sessionId ?? `s-${opts.id}`,
        pid: 12345,
      },
    },
  };
}

describe('classifyOperatorAction', () => {
  it('classifies pr subcommands', () => {
    expect(classifyOperatorAction(['pr', 'create', '--title', 'feat'])).toBe('pr-create');
    expect(classifyOperatorAction(['pr', 'merge', '384', '--squash'])).toBe('pr-merge');
    expect(classifyOperatorAction(['pr', 'comment', '384', '--body', 'hi'])).toBe('pr-comment');
    expect(classifyOperatorAction(['pr', 'edit', '384'])).toBe('pr-edit');
    expect(classifyOperatorAction(['pr', 'reopen', '384'])).toBe('pr-edit');
    expect(classifyOperatorAction(['pr', 'close', '384'])).toBe('pr-close');
    expect(classifyOperatorAction(['pr', 'ready', '384'])).toBe('pr-ready');
    expect(classifyOperatorAction(['pr', 'review', '384'])).toBe('pr-review');
    expect(classifyOperatorAction(['pr', 'view', '384'])).toBe('other');
  });

  it('classifies issue subcommands', () => {
    expect(classifyOperatorAction(['issue', 'create', '--title', 'bug'])).toBe('issue-create');
    expect(classifyOperatorAction(['issue', 'comment', '335'])).toBe('issue-comment');
    expect(classifyOperatorAction(['issue', 'edit', '335'])).toBe('issue-edit');
    expect(classifyOperatorAction(['issue', 'close', '335'])).toBe('issue-close');
  });

  it('classifies label / release / workflow / repo', () => {
    expect(classifyOperatorAction(['label', 'create', 'autonomous-intent'])).toBe('label');
    expect(classifyOperatorAction(['release', 'create', 'v1.0'])).toBe('release');
    expect(classifyOperatorAction(['workflow', 'enable', 'ci'])).toBe('workflow');
    expect(classifyOperatorAction(['repo', 'rename', 'newname'])).toBe('repo-mutation');
  });

  it('classifies graphql mutations', () => {
    // resolveReviewThread mutation
    expect(classifyOperatorAction([
      'api', 'graphql', '-f',
      'query=mutation { resolveReviewThread(input: { threadId: "X" }) { __typename } }',
    ])).toBe('review-thread-resolve');

    // addPullRequestReview mutation
    expect(classifyOperatorAction([
      'api', 'graphql', '-f',
      'query=mutation { addPullRequestReview(input: {}) { clientMutationId } }',
    ])).toBe('pr-review');

    // mergePullRequest mutation
    expect(classifyOperatorAction([
      'api', 'graphql', '-f',
      'query=mutation { mergePullRequest(input: {}) { clientMutationId } }',
    ])).toBe('pr-merge');
  });

  it('classifies REST issues/labels writes as label', () => {
    expect(classifyOperatorAction([
      'api', 'repos/o/r/issues/335/labels',
      '-X', 'POST', '-f', 'labels[]=autonomous-intent',
    ])).toBe('label');
  });

  it('falls back to api-write for unknown api shapes and other for unknown verbs', () => {
    expect(classifyOperatorAction(['api', 'graphql', '-f', 'query=something'])).toBe('api-write');
    expect(classifyOperatorAction(['gist', 'create'])).toBe('other');
    expect(classifyOperatorAction([])).toBe('other');
  });
});

describe('deriveTarget', () => {
  it('extracts PR number from pr subcommands', () => {
    expect(deriveTarget(['pr', 'merge', '384', '--squash'])).toBe('PR #384');
    expect(deriveTarget(['pr', 'comment', '384', '--body', 'x'])).toBe('PR #384');
    expect(deriveTarget(['pr', 'view', '384'])).toBe('PR #384');
  });

  it('extracts pr create title', () => {
    expect(deriveTarget([
      'pr', 'create', '--title', 'feat(console): operator-action dashboard',
      '--body', 'long body...',
    ])).toBe('feat(console): operator-action dashboard');
  });

  it('truncates very long titles', () => {
    const longTitle = 'A'.repeat(200);
    const result = deriveTarget(['pr', 'create', '--title', longTitle]);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith('...')).toBe(true);
  });

  it('falls back to "new PR" when pr create has no title', () => {
    expect(deriveTarget(['pr', 'create'])).toBe('new PR');
  });

  it('extracts issue number from issue subcommands', () => {
    expect(deriveTarget(['issue', 'comment', '335'])).toBe('issue #335');
  });

  it('extracts target from graphql by inspecting query text', () => {
    expect(deriveTarget([
      'api', 'graphql', '-f',
      'query={ repository(owner: "x") { pullRequest(number: 384) { state } } }',
    ])).toBe('PR #384');
    expect(deriveTarget([
      'api', 'graphql', '-f',
      'query={ repository(owner: "x") { issue(number: 335) { state } } }',
    ])).toBe('issue #335');
  });

  it('extracts issue/PR number from REST path', () => {
    expect(deriveTarget(['api', 'repos/o/r/issues/335/labels'])).toBe('issue #335');
    expect(deriveTarget(['api', 'repos/o/r/pulls/384/comments'])).toBe('PR #384');
  });

  it('returns label name for label subcommands', () => {
    expect(deriveTarget(['label', 'create', 'autonomous-intent'])).toBe('label autonomous-intent');
  });

  it('returns null when nothing useful can be extracted', () => {
    expect(deriveTarget([])).toBeNull();
    expect(deriveTarget(['gist', 'create'])).toBeNull();
  });
});

describe('deriveArgsPreview', () => {
  it('joins argv with spaces', () => {
    expect(deriveArgsPreview(['pr', 'merge', '384', '--squash'])).toBe('pr merge 384 --squash');
  });

  it('truncates long previews', () => {
    const args = ['api', 'graphql', '-f', 'query=' + 'A'.repeat(300)];
    const result = deriveArgsPreview(args);
    expect(result.length).toBeLessThanOrEqual(140);
    expect(result.endsWith('...')).toBe(true);
  });
});

describe('clampLimit', () => {
  it('returns the default when limit is null or invalid', () => {
    expect(clampLimit(null)).toBe(OPERATOR_ACTIONS_DEFAULT_LIMIT);
    expect(clampLimit(undefined)).toBe(OPERATOR_ACTIONS_DEFAULT_LIMIT);
    expect(clampLimit(NaN)).toBe(OPERATOR_ACTIONS_DEFAULT_LIMIT);
    expect(clampLimit(Infinity)).toBe(OPERATOR_ACTIONS_DEFAULT_LIMIT);
  });

  it('clamps to the [1, MAX] range', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(OPERATOR_ACTIONS_MAX_LIST_ITEMS + 1)).toBe(OPERATOR_ACTIONS_MAX_LIST_ITEMS);
  });

  it('floors fractional values', () => {
    expect(clampLimit(5.7)).toBe(5);
  });
});

describe('listOperatorActions', () => {
  it('returns the empty shape when no operator-action atoms are present', () => {
    const result = listOperatorActions([], NOW);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.filtered).toBe(0);
    expect(result.actor_facets).toEqual([]);
    expect(result.action_type_facets).toEqual([]);
    expect(result.generated_at).toBe('2026-05-10T12:00:00.000Z');
  });

  it('ignores non-operator-action atoms', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      {
        id: 'plan-12345',
        type: 'plan',
        layer: 'L0',
        content: 'plan',
        principal_id: 'lag-cto',
        created_at: '2026-05-10T11:00:00.000Z',
      },
      actionAtom({
        id: 'op-action-lag-ceo-1-aaaa',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '384'],
      }),
    ];
    const result = listOperatorActions(atoms, NOW);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.atom_id).toBe('op-action-lag-ceo-1-aaaa');
  });

  it('ignores tainted and superseded atoms', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      actionAtom({
        id: 'op-action-lag-ceo-1-aaaa',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '384'],
      }),
      actionAtom({
        id: 'op-action-lag-ceo-2-bbbb',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:01:00.000Z',
        args: ['pr', 'merge', '385'],
        taint: 'compromised',
      }),
      actionAtom({
        id: 'op-action-lag-ceo-3-cccc',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:02:00.000Z',
        args: ['pr', 'merge', '386'],
        superseded: true,
      }),
    ];
    const result = listOperatorActions(atoms, NOW);
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('skips malformed atoms (no operator_action envelope)', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      actionAtom({
        id: 'op-action-lag-ceo-1-aaaa',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '384'],
      }),
      actionAtom({
        id: 'op-action-lag-ceo-2-bbbb',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:01:00.000Z',
        args: [],
        malformed: true,
      }),
    ];
    const result = listOperatorActions(atoms, NOW);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.atom_id).toBe('op-action-lag-ceo-1-aaaa');
  });

  it('sorts rows by created_at DESC with deterministic tiebreaker', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      actionAtom({
        id: 'op-action-lag-ceo-A',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '1'],
      }),
      actionAtom({
        id: 'op-action-lag-ceo-B',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:02:00.000Z',
        args: ['pr', 'merge', '2'],
      }),
      actionAtom({
        id: 'op-action-lag-ceo-C',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:01:00.000Z',
        args: ['pr', 'merge', '3'],
      }),
      // Tie on created_at; tiebreak by atom_id ASC.
      actionAtom({
        id: 'op-action-lag-ceo-D',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '4'],
      }),
    ];
    const result = listOperatorActions(atoms, NOW);
    expect(result.rows.map((r) => r.atom_id)).toEqual([
      'op-action-lag-ceo-B',
      'op-action-lag-ceo-C',
      'op-action-lag-ceo-A',
      'op-action-lag-ceo-D',
    ]);
  });

  it('filters by actor without changing the facet counts', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      actionAtom({
        id: 'op-action-lag-ceo-1',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '1'],
      }),
      actionAtom({
        id: 'op-action-lag-ceo-2',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:01:00.000Z',
        args: ['pr', 'merge', '2'],
      }),
      actionAtom({
        id: 'op-action-lag-cto-1',
        actor: 'lag-cto',
        createdAt: '2026-05-10T11:02:00.000Z',
        args: ['label', 'create', 'autonomous-intent'],
      }),
    ];
    const filtered = listOperatorActions(atoms, NOW, { actor: 'lag-ceo' });
    expect(filtered.rows).toHaveLength(2);
    expect(filtered.filtered).toBe(2);
    expect(filtered.total).toBe(3);
    // Facets reflect the unfiltered universe so the chip can show "lag-cto (1)".
    expect(filtered.actor_facets).toEqual([
      { actor: 'lag-ceo', count: 2 },
      { actor: 'lag-cto', count: 1 },
    ]);
  });

  it('filters by action_type', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      actionAtom({
        id: 'op-action-lag-ceo-1',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '1'],
      }),
      actionAtom({
        id: 'op-action-lag-ceo-2',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:01:00.000Z',
        args: ['pr', 'create', '--title', 'feat: x'],
      }),
      actionAtom({
        id: 'op-action-lag-ceo-3',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:02:00.000Z',
        args: ['label', 'create', 'autonomous-intent'],
      }),
    ];
    const filtered = listOperatorActions(atoms, NOW, { actionType: 'pr-merge' });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]?.atom_id).toBe('op-action-lag-ceo-1');
    expect(filtered.filtered).toBe(1);
    expect(filtered.total).toBe(3);
  });

  it('combines actor + action_type filters (AND semantics)', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      actionAtom({
        id: 'op-action-lag-ceo-merge',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '1'],
      }),
      actionAtom({
        id: 'op-action-lag-ceo-label',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:01:00.000Z',
        args: ['label', 'create', 'x'],
      }),
      actionAtom({
        id: 'op-action-lag-cto-merge',
        actor: 'lag-cto',
        createdAt: '2026-05-10T11:02:00.000Z',
        args: ['pr', 'merge', '2'],
      }),
    ];
    const filtered = listOperatorActions(atoms, NOW, {
      actor: 'lag-ceo',
      actionType: 'pr-merge',
    });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]?.atom_id).toBe('op-action-lag-ceo-merge');
  });

  it('respects the limit clamp', () => {
    const atoms = Array.from({ length: 20 }, (_, i) =>
      actionAtom({
        id: `op-action-lag-ceo-${i.toString().padStart(2, '0')}`,
        actor: 'lag-ceo',
        // Reverse order so id sort matches created_at sort.
        createdAt: `2026-05-10T11:${(40 - i).toString().padStart(2, '0')}:00.000Z`,
        args: ['pr', 'merge', String(i)],
      }),
    );
    const result = listOperatorActions(atoms, NOW, { limit: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.filtered).toBe(20);
    expect(result.total).toBe(20);
  });

  it('clamps an out-of-range limit', () => {
    const atoms = Array.from({ length: 3 }, (_, i) =>
      actionAtom({
        id: `op-action-lag-ceo-${i}`,
        actor: 'lag-ceo',
        createdAt: `2026-05-10T11:0${i}:00.000Z`,
        args: ['pr', 'merge', String(i)],
      }),
    );
    const negative = listOperatorActions(atoms, NOW, { limit: -10 });
    expect(negative.rows).toHaveLength(1);
    const huge = listOperatorActions(atoms, NOW, { limit: 999_999 });
    expect(huge.rows).toHaveLength(3);
  });

  it('classifies and projects action_type / target / subcommand per row', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      actionAtom({
        id: 'op-action-lag-ceo-merge',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '384', '--squash'],
        sessionId: 'gh-as-1234-abcd',
      }),
    ];
    const result = listOperatorActions(atoms, NOW);
    const row = result.rows[0]!;
    expect(row.action_type).toBe('pr-merge');
    expect(row.target).toBe('PR #384');
    expect(row.subcommand).toBe('pr merge');
    expect(row.actor).toBe('lag-ceo');
    expect(row.session_id).toBe('gh-as-1234-abcd');
    expect(row.args_preview).toBe('pr merge 384 --squash');
  });

  it('returns an empty rows array when no rows match the filter but facets still expose the universe', () => {
    const atoms: ReadonlyArray<OperatorActionSourceAtom> = [
      actionAtom({
        id: 'op-action-lag-ceo-1',
        actor: 'lag-ceo',
        createdAt: '2026-05-10T11:00:00.000Z',
        args: ['pr', 'merge', '1'],
      }),
    ];
    // An unknown actor returns no rows but the actor facet still
    // shows the known actor so the chip remains discoverable.
    const result = listOperatorActions(atoms, NOW, { actor: 'unknown-bot' });
    expect(result.rows).toHaveLength(0);
    expect(result.filtered).toBe(0);
    expect(result.total).toBe(1);
    expect(result.actor_facets).toEqual([{ actor: 'lag-ceo', count: 1 }]);
  });
});
