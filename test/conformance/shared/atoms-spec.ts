/**
 * AtomStore conformance spec.
 *
 * Every adapter implementing AtomStore must satisfy these cases. Pass the
 * factory in from the adapter's test file:
 *
 *   runAtomsSpec('memory', async () => ({
 *     host: createMemoryHost(),
 *   }));
 *
 *   runAtomsSpec('file', async () => {
 *     const rootDir = await mkdtemp(join(tmpdir(), 'lag-atoms-'));
 *     const host = await createFileHost({ rootDir });
 *     return { host, cleanup: async () => host.cleanup() };
 *   });
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../../src/substrate/errors.js';
import type { Host } from '../../../src/substrate/interface.js';
import type { AtomId, PrincipalId } from '../../../src/substrate/types.js';
import { sampleAtom } from '../../fixtures.js';
import type { TargetFactory } from './types.js';

export function runAtomsSpec(label: string, factory: TargetFactory): void {
  describe(`AtomStore conformance (${label})`, () => {
    let host: Host;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const r = await factory();
      host = r.host;
      cleanup = r.cleanup;
    });

    afterEach(async () => {
      if (cleanup) await cleanup();
    });

    it('put and get round-trip preserves content', async () => {
      const atom = sampleAtom({ content: 'hello world' });
      await host.atoms.put(atom);
      const got = await host.atoms.get(atom.id);
      expect(got).not.toBeNull();
      expect(got?.content).toBe('hello world');
      expect(got?.id).toBe(atom.id);
    });

    it('get returns null for missing id', async () => {
      const got = await host.atoms.get('missing_id' as AtomId);
      expect(got).toBeNull();
    });

    it('put with duplicate id throws ConflictError', async () => {
      const atom = sampleAtom();
      await host.atoms.put(atom);
      await expect(host.atoms.put(atom)).rejects.toBeInstanceOf(ConflictError);
    });

    it('query by layer filter returns only matching atoms', async () => {
      await host.atoms.put(sampleAtom({ id: 'a1' as AtomId, layer: 'L1' }));
      await host.atoms.put(sampleAtom({ id: 'a2' as AtomId, layer: 'L2' }));
      await host.atoms.put(sampleAtom({ id: 'a3' as AtomId, layer: 'L1' }));
      const result = await host.atoms.query({ layer: ['L1'] }, 10);
      expect(result.atoms).toHaveLength(2);
      expect(result.atoms.every(a => a.layer === 'L1')).toBe(true);
    });

    it('query excludes superseded atoms by default', async () => {
      await host.atoms.put(sampleAtom({ id: 'old' as AtomId, superseded_by: ['new' as AtomId] }));
      await host.atoms.put(sampleAtom({ id: 'new' as AtomId }));
      const result = await host.atoms.query({}, 10);
      expect(result.atoms.map(a => a.id)).not.toContain('old');
      expect(result.atoms.map(a => a.id)).toContain('new');
    });

    it('query with superseded: true includes them', async () => {
      await host.atoms.put(sampleAtom({ id: 'old' as AtomId, superseded_by: ['new' as AtomId] }));
      await host.atoms.put(sampleAtom({ id: 'new' as AtomId }));
      const result = await host.atoms.query({ superseded: true }, 10);
      expect(result.atoms.map(a => a.id).sort()).toEqual(['new', 'old']);
    });

    it('query pagination via cursor returns distinct pages', async () => {
      for (let i = 0; i < 5; i++) {
        await host.atoms.put(sampleAtom({ id: `atom_p_${i}` as AtomId }));
      }
      const p1 = await host.atoms.query({}, 2);
      expect(p1.atoms).toHaveLength(2);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await host.atoms.query({}, 2, p1.nextCursor!);
      expect(p2.atoms).toHaveLength(2);
      const ids1 = new Set(p1.atoms.map(a => a.id));
      const ids2 = new Set(p2.atoms.map(a => a.id));
      for (const id of ids1) expect(ids2.has(id)).toBe(false);
    });

    it('search ranks exact matches above unrelated text', async () => {
      await host.atoms.put(sampleAtom({ id: 'postgres' as AtomId, content: 'we use postgres for the main database' }));
      await host.atoms.put(sampleAtom({ id: 'redis' as AtomId, content: 'we use redis for caching' }));
      await host.atoms.put(sampleAtom({ id: 'mongo' as AtomId, content: 'we use mongodb for logs' }));
      const hits = await host.atoms.search('postgres database', 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.atom.id).toBe('postgres');
    });

    it('search respects filter', async () => {
      await host.atoms.put(sampleAtom({ id: 'd1' as AtomId, content: 'postgres', layer: 'L1' }));
      await host.atoms.put(sampleAtom({ id: 'd2' as AtomId, content: 'postgres', layer: 'L2' }));
      const hits = await host.atoms.search('postgres', 5, { layer: ['L2'] });
      expect(hits.every(h => h.atom.layer === 'L2')).toBe(true);
    });

    it('update modifies confidence', async () => {
      const atom = sampleAtom({ confidence: 0.5 });
      await host.atoms.put(atom);
      const updated = await host.atoms.update(atom.id, { confidence: 0.9 });
      expect(updated.confidence).toBe(0.9);
      const reread = await host.atoms.get(atom.id);
      expect(reread?.confidence).toBe(0.9);
    });

    it('update does not alter content', async () => {
      const atom = sampleAtom({ content: 'original' });
      await host.atoms.put(atom);
      const updated = await host.atoms.update(atom.id, { confidence: 0.1 });
      expect(updated.content).toBe('original');
    });

    it('update supersedes appends to existing', async () => {
      const atom = sampleAtom({ supersedes: ['old_a' as AtomId] });
      await host.atoms.put(atom);
      const updated = await host.atoms.update(atom.id, { supersedes: ['old_b' as AtomId] });
      expect(updated.supersedes).toEqual(['old_a', 'old_b']);
    });

    it('update missing id throws NotFoundError', async () => {
      await expect(
        host.atoms.update('never' as AtomId, { confidence: 0.1 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('batchUpdate affects all matching atoms', async () => {
      await host.atoms.put(sampleAtom({ id: 'x1' as AtomId, principal_id: 'evil' as PrincipalId, taint: 'clean' }));
      await host.atoms.put(sampleAtom({ id: 'x2' as AtomId, principal_id: 'evil' as PrincipalId, taint: 'clean' }));
      await host.atoms.put(sampleAtom({ id: 'x3' as AtomId, principal_id: 'good' as PrincipalId, taint: 'clean' }));
      const count = await host.atoms.batchUpdate(
        { principal_id: ['evil' as PrincipalId] },
        { taint: 'tainted' },
      );
      expect(count).toBe(2);
      expect((await host.atoms.get('x1' as AtomId))?.taint).toBe('tainted');
      expect((await host.atoms.get('x2' as AtomId))?.taint).toBe('tainted');
      expect((await host.atoms.get('x3' as AtomId))?.taint).toBe('clean');
    });

    it('embed is deterministic across calls', async () => {
      const v1 = await host.atoms.embed('the quick brown fox');
      const v2 = await host.atoms.embed('the quick brown fox');
      expect(v1).toEqual(v2);
    });

    it('similarity is symmetric', async () => {
      const v1 = await host.atoms.embed('postgres database');
      const v2 = await host.atoms.embed('postgres server');
      expect(host.atoms.similarity(v1, v2)).toBeCloseTo(host.atoms.similarity(v2, v1), 10);
    });

    it('similarity of identical vectors is 1', async () => {
      const v = await host.atoms.embed('anything');
      expect(host.atoms.similarity(v, v)).toBeCloseTo(1.0, 6);
    });

    it('contentHash normalizes case and trailing punctuation', () => {
      expect(host.atoms.contentHash('Use Postgres.')).toBe(host.atoms.contentHash('use postgres'));
      expect(host.atoms.contentHash('We Use Postgres!')).toBe(host.atoms.contentHash('we use postgres'));
    });

    it('contentHash differs for semantically different text', () => {
      expect(host.atoms.contentHash('use postgres')).not.toBe(host.atoms.contentHash('use mysql'));
    });
  });
}
