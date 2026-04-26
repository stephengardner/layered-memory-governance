import { describe, it, expect } from 'vitest';
import {
  buildActorActivityResponse,
  ACTOR_ACTIVITY_MAX_LIMIT,
  type ActorActivityAtom,
} from './actor-activity';

/*
 * Pure-function tests for the actor-activity transform. The server's
 * HTTP route is a thin wrapper around this; if these pass and the
 * route handler delegates correctly, we have full coverage of the
 * read + group logic without a TCP socket.
 *
 * Determinism: all tests pass `now` explicitly so no system clock
 * dependence creeps in.
 */

const NOW = new Date('2026-04-26T12:00:00.000Z');

function atom(partial: Partial<ActorActivityAtom> & { id: string; principal_id: string; created_at: string }): ActorActivityAtom {
  return {
    type: 'observation',
    layer: 'L1',
    content: 'sample content',
    confidence: 0.5,
    ...partial,
  };
}

describe('buildActorActivityResponse', () => {
  it('returns empty groups when no atoms exist', () => {
    const r = buildActorActivityResponse([], {}, NOW);
    expect(r.groups).toEqual([]);
    expect(r.entry_count).toBe(0);
    expect(r.principal_count).toBe(0);
    expect(r.generated_at).toBe('2026-04-26T12:00:00.000Z');
  });

  it('sorts entries by created_at DESC', () => {
    const atoms: ActorActivityAtom[] = [
      atom({ id: 'a-1', principal_id: 'p1', created_at: '2026-04-26T10:00:00.000Z' }),
      atom({ id: 'a-3', principal_id: 'p1', created_at: '2026-04-26T11:30:00.000Z' }),
      atom({ id: 'a-2', principal_id: 'p1', created_at: '2026-04-26T11:00:00.000Z' }),
    ];
    const r = buildActorActivityResponse(atoms, {}, NOW);
    // All same principal -> one group, entries DESC.
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.entries.map((e) => e.id)).toEqual(['a-3', 'a-2', 'a-1']);
  });

  it('groups consecutive runs by principal_id, breaking when it changes', () => {
    const atoms: ActorActivityAtom[] = [
      // Insert order does not matter; sort handles ordering.
      atom({ id: 'p1-a', principal_id: 'p1', created_at: '2026-04-26T11:00:00.000Z' }),
      atom({ id: 'p1-b', principal_id: 'p1', created_at: '2026-04-26T10:55:00.000Z' }),
      atom({ id: 'p2-a', principal_id: 'p2', created_at: '2026-04-26T10:50:00.000Z' }),
      atom({ id: 'p1-c', principal_id: 'p1', created_at: '2026-04-26T10:45:00.000Z' }),
      atom({ id: 'p1-d', principal_id: 'p1', created_at: '2026-04-26T10:40:00.000Z' }),
    ];
    const r = buildActorActivityResponse(atoms, {}, NOW);
    expect(r.groups.map((g) => g.principal_id)).toEqual(['p1', 'p2', 'p1']);
    expect(r.groups[0]!.entries.map((e) => e.id)).toEqual(['p1-a', 'p1-b']);
    expect(r.groups[1]!.entries.map((e) => e.id)).toEqual(['p2-a']);
    expect(r.groups[2]!.entries.map((e) => e.id)).toEqual(['p1-c', 'p1-d']);
    // Group key is stable + collision-free across same-principal runs.
    expect(r.groups[0]!.key).toBe('p1:p1-a');
    expect(r.groups[2]!.key).toBe('p1:p1-c');
    expect(r.principal_count).toBe(2);
    expect(r.entry_count).toBe(5);
  });

  it('filters out superseded atoms', () => {
    const atoms: ActorActivityAtom[] = [
      atom({ id: 'live', principal_id: 'p1', created_at: '2026-04-26T11:00:00.000Z' }),
      atom({
        id: 'gone',
        principal_id: 'p1',
        created_at: '2026-04-26T11:05:00.000Z',
        superseded_by: ['live'],
      }),
    ];
    const r = buildActorActivityResponse(atoms, {}, NOW);
    expect(r.entry_count).toBe(1);
    expect(r.groups[0]!.entries[0]!.id).toBe('live');
  });

  it('filters out tainted atoms', () => {
    const atoms: ActorActivityAtom[] = [
      atom({ id: 'clean', principal_id: 'p1', created_at: '2026-04-26T11:00:00.000Z', taint: 'clean' }),
      atom({ id: 'dirty', principal_id: 'p1', created_at: '2026-04-26T11:05:00.000Z', taint: 'compromised' }),
    ];
    const r = buildActorActivityResponse(atoms, {}, NOW);
    expect(r.entry_count).toBe(1);
    expect(r.groups[0]!.entries[0]!.id).toBe('clean');
  });

  it('respects caller limit and clamps above max', () => {
    const atoms: ActorActivityAtom[] = Array.from({ length: 600 }, (_, i) =>
      atom({
        id: `a-${String(i).padStart(4, '0')}`,
        principal_id: 'p1',
        // Newest-first: higher i -> later timestamp.
        created_at: new Date(Date.parse('2026-04-26T00:00:00.000Z') + i * 1000).toISOString(),
      }),
    );

    const small = buildActorActivityResponse(atoms, { limit: 5 }, NOW);
    expect(small.entry_count).toBe(5);

    const huge = buildActorActivityResponse(atoms, { limit: 99999 }, NOW);
    expect(huge.entry_count).toBe(ACTOR_ACTIVITY_MAX_LIMIT);

    const negative = buildActorActivityResponse(atoms, { limit: -3 }, NOW);
    expect(negative.entry_count).toBe(1);

    const undef = buildActorActivityResponse(atoms, {}, NOW);
    expect(undef.entry_count).toBe(100);
  });

  it('truncates long content into a bounded excerpt', () => {
    const longContent = 'x'.repeat(5000);
    const atoms: ActorActivityAtom[] = [
      atom({
        id: 'big',
        principal_id: 'p1',
        created_at: '2026-04-26T11:00:00.000Z',
        content: longContent,
      }),
    ];
    const r = buildActorActivityResponse(atoms, {}, NOW);
    const excerpt = r.groups[0]!.entries[0]!.excerpt;
    expect(excerpt.length).toBeLessThanOrEqual(241);
    expect(excerpt.endsWith('\u2026')).toBe(true);
  });

  it('maps atom types to human verbs', () => {
    const atoms: ActorActivityAtom[] = [
      atom({ id: 'a', type: 'plan', principal_id: 'p1', created_at: '2026-04-26T11:00:00.000Z' }),
      atom({ id: 'b', type: 'directive', principal_id: 'p1', created_at: '2026-04-26T10:59:00.000Z' }),
      atom({ id: 'c', type: 'observation', principal_id: 'p1', created_at: '2026-04-26T10:58:00.000Z' }),
      atom({ id: 'd', type: 'something-novel', principal_id: 'p1', created_at: '2026-04-26T10:57:00.000Z' }),
    ];
    const r = buildActorActivityResponse(atoms, {}, NOW);
    const verbs = r.groups[0]!.entries.map((e) => e.verb);
    expect(verbs).toEqual(['drafted a plan', 'declared a directive', 'observed', 'wrote']);
  });

  it('counts distinct principals across consecutive runs', () => {
    const atoms: ActorActivityAtom[] = [
      atom({ id: '1', principal_id: 'a', created_at: '2026-04-26T11:00:00.000Z' }),
      atom({ id: '2', principal_id: 'b', created_at: '2026-04-26T10:55:00.000Z' }),
      atom({ id: '3', principal_id: 'a', created_at: '2026-04-26T10:50:00.000Z' }),
      atom({ id: '4', principal_id: 'c', created_at: '2026-04-26T10:45:00.000Z' }),
    ];
    const r = buildActorActivityResponse(atoms, {}, NOW);
    expect(r.principal_count).toBe(3);
    expect(r.groups).toHaveLength(4); // a,b,a,c -> four runs
  });

  it('latest_at on a group is the most-recent entry timestamp', () => {
    const atoms: ActorActivityAtom[] = [
      atom({ id: '1', principal_id: 'a', created_at: '2026-04-26T11:00:00.000Z' }),
      atom({ id: '2', principal_id: 'a', created_at: '2026-04-26T10:00:00.000Z' }),
    ];
    const r = buildActorActivityResponse(atoms, {}, NOW);
    expect(r.groups[0]!.latest_at).toBe('2026-04-26T11:00:00.000Z');
  });
});
