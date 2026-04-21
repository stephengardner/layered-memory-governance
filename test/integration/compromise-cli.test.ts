/**
 * Spawn-based smoke test for `lag-compromise`.
 *
 * Seeds a FileHost on disk with a compromise scene (alice clean, bob
 * later-compromised, carol derives from bob), spawns the compiled CLI
 * with --yes, and asserts the file state after:
 *   - principal `bob` has compromised_at set
 *   - bob's post-compromise atom is tainted
 *   - carol's derived atom is tainted (transitive)
 *   - alice's atoms remain clean
 *   - audit log contains 'atom.tainted' events
 *
 * Gated by LAG_SPAWN_TEST=1 (same gate as cli-spawn.smoke) so the
 * default `npm test` skips subprocess spawns.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHost, type FileHost } from '../../src/adapters/file/index.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { samplePrincipal, sampleAtom } from '../fixtures.js';

const SPAWN_ENABLED = process.env['LAG_SPAWN_TEST'] === '1';
const describeMaybe = SPAWN_ENABLED ? describe : describe.skip;
const COMPROMISE_PATH = resolve('dist/cli/compromise.js');

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise(r => child.once('exit', code => r(code ?? -1)));
}

describeMaybe('lag-compromise CLI: mark + propagate end-to-end', () => {
  let rootDir: string;
  let host: FileHost;
  let cliProc: ChildProcess | null = null;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lag-compromise-cli-'));
    host = await createFileHost({ rootDir });

    const now = host.clock.now();
    const nowMs = Date.parse(now);

    await host.principals.put(samplePrincipal({ id: 'alice' as PrincipalId }));
    await host.principals.put(samplePrincipal({ id: 'bob' as PrincipalId }));
    await host.principals.put(samplePrincipal({ id: 'carol' as PrincipalId }));

    // Alice clean atom.
    await host.atoms.put(sampleAtom({
      id: 'alice_ok' as AtomId,
      content: 'Alice honest observation.',
      principal_id: 'alice' as PrincipalId,
      created_at: new Date(nowMs - 60_000).toISOString() as Time,
      last_reinforced_at: new Date(nowMs - 60_000).toISOString() as Time,
      layer: 'L2',
    }));

    // Bob post-compromise atom (created "now", which will be >= compromised_at
    // when the CLI marks him compromised).
    await host.atoms.put(sampleAtom({
      id: 'bob_poisoned' as AtomId,
      content: 'Bob post-compromise observation.',
      principal_id: 'bob' as PrincipalId,
      created_at: new Date(nowMs + 1000).toISOString() as Time,
      last_reinforced_at: new Date(nowMs + 1000).toISOString() as Time,
      layer: 'L2',
    }));

    // Carol derives from bob's poisoned atom (transitive taint target).
    await host.atoms.put(sampleAtom({
      id: 'carol_derived' as AtomId,
      content: 'Carol built on bob output.',
      principal_id: 'carol' as PrincipalId,
      created_at: new Date(nowMs + 2000).toISOString() as Time,
      last_reinforced_at: new Date(nowMs + 2000).toISOString() as Time,
      layer: 'L2',
      provenance: {
        kind: 'agent-inferred',
        source: { agent_id: 'carol' },
        derived_from: ['bob_poisoned' as AtomId],
      },
    }));
  });

  afterEach(async () => {
    if (cliProc && cliProc.exitCode === null && !cliProc.killed) {
      cliProc.kill('SIGKILL');
      try { await waitForExit(cliProc); } catch { /* ignore */ }
    }
    cliProc = null;
    try { await host.cleanup(); } catch { /* ignore */ }
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('--yes path: marks bob compromised, taints bob + carol, leaves alice clean', async () => {
    const out: string[] = [];
    const err: string[] = [];
    cliProc = spawn(
      process.execPath,
      [
        COMPROMISE_PATH,
        '--root-dir', rootDir,
        '--principal', 'bob',
        '--reason', 'oauth token leaked',
        '--responder', 'soc-on-call',
        '--yes',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    cliProc.stdout?.on('data', (c: Buffer) => out.push(c.toString()));
    cliProc.stderr?.on('data', (c: Buffer) => err.push(c.toString()));
    const code = await waitForExit(cliProc);
    const stdout = out.join('');
    const stderr = err.join('');
    expect(code, `cli exited ${code}. stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
    expect(stdout).toMatch(/marked bob compromised at/i);
    expect(stdout).toMatch(/atoms tainted:\s*2/);

    // --- Assert file-level state reflects the taint cascade.
    // Re-read principal: must be compromised.
    const freshHost = await createFileHost({ rootDir });
    try {
      const bob = await freshHost.principals.get('bob' as PrincipalId);
      expect(bob?.compromised_at).not.toBeNull();
      expect(bob?.active).toBe(false);

      const alice = await freshHost.atoms.get('alice_ok' as AtomId);
      expect(alice?.taint).toBe('clean');

      const bobAtom = await freshHost.atoms.get('bob_poisoned' as AtomId);
      expect(bobAtom?.taint).toBe('tainted');

      const carolAtom = await freshHost.atoms.get('carol_derived' as AtomId);
      expect(carolAtom?.taint).toBe('tainted');

      // Audit log contains the taint events, attributed to the responder.
      const audits = await freshHost.auditor.query({ kind: ['atom.tainted'] }, 20);
      expect(audits.length).toBe(2);
      for (const a of audits) {
        expect(a.principal_id).toBe('soc-on-call');
        expect(a.details['trigger_principal']).toBe('bob');
      }
    } finally {
      try { await freshHost.cleanup(); } catch { /* ignore */ }
    }
  }, 60_000);

  it('unknown principal exits 1 with a clear message', async () => {
    const err: string[] = [];
    const proc = spawn(
      process.execPath,
      [
        COMPROMISE_PATH,
        '--root-dir', rootDir,
        '--principal', 'nobody-knows',
        '--reason', 'test',
        '--yes',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    proc.stderr?.on('data', (c: Buffer) => err.push(c.toString()));
    cliProc = proc;
    const code = await waitForExit(proc);
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/not found/i);
  }, 30_000);

  it('missing required arg exits 1', async () => {
    const err: string[] = [];
    const proc = spawn(
      process.execPath,
      [
        COMPROMISE_PATH,
        '--root-dir', rootDir,
        // no --principal, no --reason
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    proc.stderr?.on('data', (c: Buffer) => err.push(c.toString()));
    cliProc = proc;
    const code = await waitForExit(proc);
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/required/i);
  }, 30_000);
});
