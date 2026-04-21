/**
 * Multi-target canon (Phase 32): the autonomous-organization story,
 * verified end-to-end.
 *
 * Scenario: an org, an engineering project, and a team each have their
 * own `CLAUDE.md`. L3 atoms are tagged with `scope` (global / project /
 * user). The LoopRunner renders each target with a scope-filtered view,
 * so every audience reads only what applies to them.
 *
 * This test proves two invariants:
 *   1. Atoms route to the right target file based on scope filter.
 *   2. Atoms with non-matching scope do NOT leak into other targets'
 *      files.
 *
 * Both matter for a real org: you do NOT want an individual agent's
 * scratch notes to appear in the org-wide CLAUDE.md, and you do not
 * want the CEO's org-wide directives to accidentally be missing from
 * the team file either.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHost, type FileHost } from '../../src/adapters/file/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 'multi-target-loop' as PrincipalId;

let rootDir: string;
let docsDir: string;
let host: FileHost;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'lag-mt-canon-root-'));
  docsDir = await mkdtemp(join(tmpdir(), 'lag-mt-canon-docs-'));
  host = await createFileHost({ rootDir });
});

afterEach(async () => {
  try { await host.cleanup(); } catch { /* ignore */ }
  try { await rm(docsDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Multi-target canon (autonomous-org pattern)', () => {
  it('routes L3 atoms to per-scope target files without cross-leak', async () => {
    // Three L3 atoms, one per scope tier. Content is deliberately distinct
    // so the cross-leak assertion can search for each string cleanly.
    const now = host.clock.now();
    await host.atoms.put(sampleAtom({
      id: 'org-invariant' as AtomId,
      content: 'Org-wide invariant: all services emit structured logs.',
      type: 'directive',
      layer: 'L3',
      scope: 'global',
      confidence: 0.98,
      created_at: now as Time,
      last_reinforced_at: now as Time,
    }));
    await host.atoms.put(sampleAtom({
      id: 'eng-convention' as AtomId,
      content: 'Engineering convention: Postgres for OLTP.',
      type: 'decision',
      layer: 'L3',
      scope: 'project',
      confidence: 0.95,
      created_at: now as Time,
      last_reinforced_at: now as Time,
    }));
    await host.atoms.put(sampleAtom({
      id: 'alice-note' as AtomId,
      content: 'Alice personal note: prefers tabs over spaces.',
      type: 'preference',
      layer: 'L3',
      scope: 'user',
      confidence: 0.9,
      created_at: now as Time,
      last_reinforced_at: now as Time,
    }));

    const orgFile = join(docsDir, 'ORG-CLAUDE.md');
    const engFile = join(docsDir, 'ENG-CLAUDE.md');
    const aliceFile = join(docsDir, 'ALICE-CLAUDE.md');

    const runner = new LoopRunner(host, {
      principalId: principal,
      runL2Promotion: false,
      runL3Promotion: false,
      canonTargets: [
        { path: orgFile,   filter: { scope: ['global'] } },
        { path: engFile,   filter: { scope: ['project'] } },
        { path: aliceFile, filter: { scope: ['user'] } },
      ],
    });

    const report = await runner.tick();
    expect(report.errors).toEqual([]);
    expect(report.canonApplied).toBe(3); // all three targets wrote

    const orgText = await readFile(orgFile, 'utf8');
    expect(orgText).toContain('Org-wide invariant');
    expect(orgText).not.toContain('Engineering convention');
    expect(orgText).not.toContain('Alice personal note');

    const engText = await readFile(engFile, 'utf8');
    expect(engText).toContain('Engineering convention');
    expect(engText).not.toContain('Org-wide invariant');
    expect(engText).not.toContain('Alice personal note');

    const aliceText = await readFile(aliceFile, 'utf8');
    expect(aliceText).toContain('Alice personal note');
    expect(aliceText).not.toContain('Org-wide invariant');
    expect(aliceText).not.toContain('Engineering convention');
  });

  it('legacy single-target (canonTargetPath) still works', async () => {
    const now = host.clock.now();
    await host.atoms.put(sampleAtom({
      id: 'legacy-atom' as AtomId,
      content: 'Single-target canon still renders.',
      layer: 'L3',
      confidence: 0.98,
      created_at: now as Time,
      last_reinforced_at: now as Time,
    }));

    const legacyFile = join(docsDir, 'LEGACY-CLAUDE.md');
    const runner = new LoopRunner(host, {
      principalId: principal,
      runL2Promotion: false,
      runL3Promotion: false,
      canonTargetPath: legacyFile,
    });
    const report = await runner.tick();
    expect(report.canonApplied).toBe(1);
    const text = await readFile(legacyFile, 'utf8');
    expect(text).toContain('Single-target canon still renders');
  });

  it('canonTargets takes precedence when both are set', async () => {
    const now = host.clock.now();
    await host.atoms.put(sampleAtom({
      id: 'atom-a' as AtomId,
      content: 'Scope-A atom.',
      layer: 'L3',
      scope: 'global',
      created_at: now as Time,
      last_reinforced_at: now as Time,
    }));

    const legacyFile = join(docsDir, 'LEGACY.md');
    const multiFile = join(docsDir, 'MULTI.md');
    const runner = new LoopRunner(host, {
      principalId: principal,
      runL2Promotion: false,
      runL3Promotion: false,
      canonTargetPath: legacyFile,             // should be ignored
      canonTargets: [{ path: multiFile }],     // wins
    });
    await runner.tick();

    // Multi wrote; legacy did not.
    const multiText = await readFile(multiFile, 'utf8');
    expect(multiText).toContain('Scope-A atom');
    let legacyExists = false;
    try { await readFile(legacyFile); legacyExists = true; } catch { /* ENOENT */ }
    expect(legacyExists).toBe(false);
  });

  it('target without a filter still automatically scopes to L3 (no L0/L1/L2 leak)', async () => {
    const now = host.clock.now();
    await host.atoms.put(sampleAtom({
      id: 'l1-draft' as AtomId,
      content: 'L1 working draft, not canon-ready.',
      layer: 'L1',
      created_at: now as Time,
      last_reinforced_at: now as Time,
    }));
    await host.atoms.put(sampleAtom({
      id: 'l3-official' as AtomId,
      content: 'L3 official record.',
      layer: 'L3',
      created_at: now as Time,
      last_reinforced_at: now as Time,
    }));

    const file = join(docsDir, 'ALL.md');
    const runner = new LoopRunner(host, {
      principalId: principal,
      runL2Promotion: false,
      runL3Promotion: false,
      canonTargets: [{ path: file }], // no filter; mandatory layer=L3 still applies
    });
    await runner.tick();
    const text = await readFile(file, 'utf8');
    expect(text).toContain('L3 official record');
    expect(text).not.toContain('L1 working draft');
  });
});
