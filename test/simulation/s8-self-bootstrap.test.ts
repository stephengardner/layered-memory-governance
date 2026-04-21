/**
 * Scenario s8: self-bootstrap reproducibility.
 *
 * The repo's own `scripts/bootstrap.mjs` seeds a curated set of L3
 * atoms from the `lag-self` root principal and renders them to
 * `CLAUDE.md` via LoopRunner canon-target. This scenario proves
 * two invariants of that bootstrap shape:
 *
 *   1. A fresh host, seeded with a small curated atom set at L3,
 *      produces a canon file with all expected type groupings and
 *      atom content rendered.
 *   2. Running the canon applier a second time against the same
 *      atom set produces byte-identical output (the generator's
 *      "now" derives from the newest atom timestamp, not wall
 *      clock; and LoopRunner's canon applier short-circuits on
 *      unchanged content).
 *
 * This is Principle 5 ("testable via simulation; if it cannot self-
 * bootstrap from its own design conversation, it does not work")
 * made explicit as a scenario test.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHost, type FileHost } from '../../src/adapters/file/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import type { AtomId, AtomType, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom, samplePrincipal } from '../fixtures.js';

const principalId = 'lag-self' as PrincipalId;
const FROZEN_TIME = '2026-04-19T00:00:00.000Z' as Time;

/**
 * A miniature version of the real bootstrap seed set: one atom per
 * type group, enough to exercise the full render path without
 * copying the production atom list.
 */
const MINI_SEED: ReadonlyArray<{
  id: string;
  type: AtomType;
  content: string;
}> = [
  {
    id: 'inv-test-directive',
    type: 'directive',
    content: 'Test directive: do the thing.',
  },
  {
    id: 'arch-test-decision',
    type: 'decision',
    content: 'Test decision: we chose approach X over Y.',
  },
  {
    id: 'conv-test-preference',
    type: 'preference',
    content: 'Test preference: default value is 42.',
  },
  {
    id: 'ref-test-reference',
    type: 'reference',
    content: 'Test reference: docs/framework.md has the full model.',
  },
];

let stateDir: string;
let docsDir: string;
let host: FileHost;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lag-s8-state-'));
  docsDir = await mkdtemp(join(tmpdir(), 'lag-s8-docs-'));
  host = await createFileHost({ rootDir: stateDir });

  await host.principals.put(samplePrincipal({
    id: principalId,
    name: 'lag-self',
    role: 'user',
    signed_by: null,
    created_at: FROZEN_TIME,
  }));

  for (const seed of MINI_SEED) {
    await host.atoms.put(sampleAtom({
      id: seed.id as AtomId,
      content: seed.content,
      type: seed.type,
      layer: 'L3',
      confidence: 1.0,
      provenance: {
        kind: 'user-directive',
        source: { agent_id: principalId },
        derived_from: [],
      },
      scope: 'global',
      principal_id: principalId,
      created_at: FROZEN_TIME,
      last_reinforced_at: FROZEN_TIME,
    }));
  }
});

afterEach(async () => {
  try { await host.cleanup(); } catch { /* ignore */ }
  try { await rm(docsDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('s8: self-bootstrap produces a valid canon file', () => {
  it('renders every seed atom into a grouped CLAUDE.md section', async () => {
    const canonFile = join(docsDir, 'CLAUDE.md');
    const runner = new LoopRunner(host, {
      principalId,
      runTtlPass: false,
      runL2Promotion: false,
      runL3Promotion: false,
      runCanonApplier: true,
      canonTargets: [{ path: canonFile, renderOptions: { now: FROZEN_TIME } }],
    });
    const report = await runner.tick();
    expect(report.errors).toEqual([]);
    expect(report.canonApplied).toBe(1);

    const text = await readFile(canonFile, 'utf8');

    // Structural markers.
    expect(text).toContain('<!-- lag:canon-start -->');
    expect(text).toContain('<!-- lag:canon-end -->');
    expect(text).toContain('# LAG Canon');

    // Every type group present.
    expect(text).toContain('## Directives');
    expect(text).toContain('## Decisions');
    expect(text).toContain('## Preferences');
    expect(text).toContain('## References');

    // Every seeded atom's content appears in the rendered canon.
    for (const seed of MINI_SEED) {
      expect(text).toContain(seed.content);
    }
  });

  it('re-rendering against unchanged atoms produces byte-identical output', async () => {
    const canonFile = join(docsDir, 'CLAUDE.md');
    const runner = new LoopRunner(host, {
      principalId,
      runTtlPass: false,
      runL2Promotion: false,
      runL3Promotion: false,
      runCanonApplier: true,
      canonTargets: [{ path: canonFile, renderOptions: { now: FROZEN_TIME } }],
    });

    const first = await runner.tick();
    expect(first.canonApplied).toBe(1);
    const textAfterFirst = await readFile(canonFile, 'utf8');

    // Second tick should detect no change and skip the write.
    const second = await runner.tick();
    expect(second.canonApplied).toBe(0);
    const textAfterSecond = await readFile(canonFile, 'utf8');

    expect(textAfterSecond).toBe(textAfterFirst);
  });

  it('tainted atom is excluded from canon on next render', async () => {
    const canonFile = join(docsDir, 'CLAUDE.md');
    const runner = new LoopRunner(host, {
      principalId,
      runTtlPass: false,
      runL2Promotion: false,
      runL3Promotion: false,
      runCanonApplier: true,
      canonTargets: [{ path: canonFile, renderOptions: { now: FROZEN_TIME } }],
    });
    await runner.tick();

    // Quarantine one seed atom.
    await host.atoms.update('inv-test-directive' as AtomId, {
      taint: 'quarantined',
    });
    // Bump the "now" so the renderer issues a new write.
    const bumpedNow = '2026-04-20T00:00:00.000Z' as Time;
    const runner2 = new LoopRunner(host, {
      principalId,
      runTtlPass: false,
      runL2Promotion: false,
      runL3Promotion: false,
      runCanonApplier: true,
      canonTargets: [{ path: canonFile, renderOptions: { now: bumpedNow } }],
    });
    const r = await runner2.tick();
    expect(r.canonApplied).toBe(1);

    const text = await readFile(canonFile, 'utf8');
    expect(text).not.toContain('Test directive: do the thing.');
    // Other types still render.
    expect(text).toContain('Test decision');
    expect(text).toContain('Test preference');
    expect(text).toContain('Test reference');
  });

  it('superseded atom is excluded from canon', async () => {
    const canonFile = join(docsDir, 'CLAUDE.md');
    const runner = new LoopRunner(host, {
      principalId,
      runTtlPass: false,
      runL2Promotion: false,
      runL3Promotion: false,
      runCanonApplier: true,
      canonTargets: [{ path: canonFile, renderOptions: { now: FROZEN_TIME } }],
    });
    await runner.tick();

    // Add a new atom that supersedes the existing decision.
    const supersedingId = 'arch-test-decision-v2' as AtomId;
    await host.atoms.put(sampleAtom({
      id: supersedingId,
      content: 'Test decision v2: actually we chose approach Z.',
      type: 'decision',
      layer: 'L3',
      confidence: 1.0,
      provenance: {
        kind: 'user-directive',
        source: { agent_id: principalId },
        derived_from: [],
      },
      scope: 'global',
      principal_id: principalId,
      created_at: '2026-04-20T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-04-20T00:00:00.000Z' as Time,
    }));
    await host.atoms.update('arch-test-decision' as AtomId, {
      superseded_by: [supersedingId],
    });

    const bumpedNow = '2026-04-20T00:00:00.000Z' as Time;
    const runner2 = new LoopRunner(host, {
      principalId,
      runTtlPass: false,
      runL2Promotion: false,
      runL3Promotion: false,
      runCanonApplier: true,
      canonTargets: [{ path: canonFile, renderOptions: { now: bumpedNow } }],
    });
    await runner2.tick();

    const text = await readFile(canonFile, 'utf8');
    // Superseded decision gone; superseding decision present.
    expect(text).not.toContain('Test decision: we chose approach X over Y.');
    expect(text).toContain('Test decision v2: actually we chose approach Z.');
  });
});
