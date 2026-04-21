/**
 * File adapter conformance.
 *
 * The six Host interfaces exercise the shared specs (test/conformance/shared).
 * Anything adapter-specific; most importantly the cross-session persistence
 * primitive (Q-γ); stays in this file.
 *
 * Each shared spec spins up a fresh tmp rootDir per test via the factory, and
 * the `cleanup` callback releases it in afterEach. The cross-session tests
 * build their own hosts because they explicitly need two Host instances
 * sharing a single rootDir.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHost, type FileHost } from '../../src/adapters/file/index.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';
import { runAtomsSpec } from './shared/atoms-spec.js';
import { runAuditorSpec } from './shared/auditor-spec.js';
import { runCanonSpec } from './shared/canon-spec.js';
import { runNotifierSpec } from './shared/notifier-spec.js';
import { runPrincipalsSpec } from './shared/principals-spec.js';
import { runSchedulerSpec } from './shared/scheduler-spec.js';

async function makeFileTarget() {
  const rootDir = await mkdtemp(join(tmpdir(), 'lag-file-conf-'));
  const host = await createFileHost({ rootDir });
  return {
    host,
    cleanup: async () => {
      try { await host.cleanup(); } catch { /* ignore */ }
      try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// --- Parameterized spec invocations ----------------------------------------

runAtomsSpec('file', makeFileTarget);
runCanonSpec('file', makeFileTarget);
runPrincipalsSpec('file', makeFileTarget);
runNotifierSpec('file', makeFileTarget);
runSchedulerSpec('file', makeFileTarget);
runAuditorSpec('file', makeFileTarget);

// --- Adapter-specific: Auditor size, append-only durability ----------------

describe('FileAuditor adapter-specific (append-only durability)', () => {
  let rootDir: string;
  let host: FileHost;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-file-audit-'));
    host = await createFileHost({ rootDir });
  });

  afterEach(async () => {
    try { await host.cleanup(); } catch { /* ignore */ }
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('size is monotonically non-decreasing across log calls', async () => {
    for (let i = 0; i < 5; i++) {
      const before = await host.auditor.size();
      await host.auditor.log({
        kind: `file.audit.k${i}`,
        principal_id: 'user_1' as PrincipalId,
        timestamp: new Date().toISOString() as Time,
        refs: {},
        details: {},
      });
      const after = await host.auditor.size();
      expect(after).toBeGreaterThanOrEqual(before);
    }
    expect(await host.auditor.size()).toBe(5);
  });
});

// --- Cross-session persistence (Q-γ answer) --------------------------------

describe('Cross-session persistence (Q-γ answer)', () => {
  let rootDir: string;
  let host: FileHost;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-file-cross-'));
    host = await createFileHost({ rootDir });
  });

  afterEach(async () => {
    try { await host.cleanup(); } catch { /* ignore */ }
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('second Host at same rootDir observes the first Host\'s atom writes', async () => {
    const a = sampleAtom({ content: 'written by session A' });
    await host.atoms.put(a);
    const hostB = await createFileHost({ rootDir });
    const seenByB = await hostB.atoms.get(a.id);
    expect(seenByB?.content).toBe('written by session A');
  });

  it('second Host observes canon commits from the first Host', async () => {
    const admin = 'admin_1' as PrincipalId;
    const pid = await host.canon.propose(
      { path: 'shared', before: '', after: 'use postgres', reason: 'seed' },
      admin,
      'seed',
    );
    await host.canon.commit(pid, admin);

    const hostB = await createFileHost({ rootDir });
    expect(await hostB.canon.read('shared')).toBe('use postgres');
    const history = await hostB.canon.history();
    expect(history.length).toBeGreaterThan(0);
  });

  it('two Hosts writing different atoms do not collide', async () => {
    const hostB = await createFileHost({ rootDir });
    const a = sampleAtom({ id: 'write-a' as AtomId, content: 'from A' });
    const b = sampleAtom({ id: 'write-b' as AtomId, content: 'from B' });
    await Promise.all([host.atoms.put(a), hostB.atoms.put(b)]);
    expect((await host.atoms.get(b.id))?.content).toBe('from B');
    expect((await hostB.atoms.get(a.id))?.content).toBe('from A');
  });

  it('audit log from session A is visible to session B', async () => {
    await host.auditor.log({
      kind: 'test.cross-session',
      principal_id: 'user' as PrincipalId,
      timestamp: new Date().toISOString() as Time,
      refs: {},
      details: { marker: 'hello-from-A' },
    });
    const hostB = await createFileHost({ rootDir });
    const out = await hostB.auditor.query({ kind: ['test.cross-session'] }, 10);
    expect(out.length).toBe(1);
    expect(out[0]?.details['marker']).toBe('hello-from-A');
  });
});
