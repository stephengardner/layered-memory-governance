/**
 * Unit tests for createKillSwitch.
 *
 * Scope: the primitive itself. Integration with runActor and
 * adapters lives in follow-up PRs; those have their own tests.
 *
 * Test uses a real tmpdir (node:fs temp directory) so the
 * fs.watch + setInterval interactions with the actual
 * filesystem are exercised. Each test creates a fresh tmp dir
 * so parallel test runs do not step on each other.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createKillSwitch,
  isKillSwitchAbortReason,
  type KillSwitchController,
} from '../../src/kill-switch/index.js';

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('createKillSwitch', () => {
  let stateDir: string;
  const disposables: KillSwitchController[] = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'lag-ks-test-'));
  });

  afterEach(() => {
    for (const d of disposables) d.dispose();
    disposables.length = 0;
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // tmpdir on Windows can briefly hold a handle after
      // watcher close; best-effort cleanup is fine for tests.
    }
  });

  it('rejects an empty stateDir', () => {
    expect(() => createKillSwitch({ stateDir: '' })).toThrow(/stateDir/);
  });

  it('does not trip when the sentinel is absent', async () => {
    const ks = createKillSwitch({ stateDir, pollFallbackMs: 50 });
    disposables.push(ks);
    expect(ks.tripped).toBe(false);
    expect(ks.trippedBy).toBe(null);
    expect(ks.signal.aborted).toBe(false);
  });

  it('trips immediately at construction when the sentinel already exists', () => {
    writeFileSync(join(stateDir, 'STOP'), '');
    const ks = createKillSwitch({ stateDir });
    disposables.push(ks);
    expect(ks.tripped).toBe(true);
    expect(ks.trippedBy).toBe('stop-sentinel');
    expect(ks.signal.aborted).toBe(true);
    expect(isKillSwitchAbortReason(ks.signal.reason)).toBe(true);
    const reason = ks.signal.reason as { kind: string; trigger: string; sentinelPath: string };
    expect(reason.kind).toBe('kill-switch');
    expect(reason.trigger).toBe('stop-sentinel');
    expect(reason.sentinelPath.endsWith('STOP')).toBe(true);
  });

  it('trips when the sentinel appears mid-run (poll fallback path)', async () => {
    // Low poll interval keeps the test fast. fs.watch may or may
    // not fire first depending on platform; either path trips.
    const ks = createKillSwitch({ stateDir, pollFallbackMs: 30 });
    disposables.push(ks);
    expect(ks.tripped).toBe(false);

    writeFileSync(join(stateDir, 'STOP'), '');

    // Give the watcher / poll a chance. 250 ms is comfortably
    // more than 30 ms poll and typical fs.watch latency.
    for (let i = 0; i < 20 && !ks.tripped; i++) await delay(20);
    expect(ks.tripped).toBe(true);
    expect(ks.trippedBy).toBe('stop-sentinel');
    expect(ks.signal.aborted).toBe(true);
  });

  it('respects a custom sentinelFilename', async () => {
    const ks = createKillSwitch({
      stateDir,
      sentinelFilename: 'HALT',
      pollFallbackMs: 30,
    });
    disposables.push(ks);
    // Writing the default name must NOT trip.
    writeFileSync(join(stateDir, 'STOP'), '');
    await delay(120);
    expect(ks.tripped).toBe(false);
    // Writing the custom name must trip.
    writeFileSync(join(stateDir, 'HALT'), '');
    for (let i = 0; i < 20 && !ks.tripped; i++) await delay(20);
    expect(ks.tripped).toBe(true);
  });

  it('trips from an already-aborted parent signal at construction', () => {
    const parent = new AbortController();
    parent.abort();
    const ks = createKillSwitch({
      stateDir,
      additionalAbortSignals: [parent.signal],
    });
    disposables.push(ks);
    expect(ks.tripped).toBe(true);
    expect(ks.trippedBy).toBe('parent-signal');
    expect(ks.signal.aborted).toBe(true);
  });

  it('trips when a parent signal aborts after construction', async () => {
    const parent = new AbortController();
    const ks = createKillSwitch({
      stateDir,
      additionalAbortSignals: [parent.signal],
    });
    disposables.push(ks);
    expect(ks.tripped).toBe(false);
    parent.abort();
    // AbortSignal listeners fire synchronously on abort.
    expect(ks.tripped).toBe(true);
    expect(ks.trippedBy).toBe('parent-signal');
  });

  it('composes with multiple parent signals (first-wins)', () => {
    const parentA = new AbortController();
    const parentB = new AbortController();
    const ks = createKillSwitch({
      stateDir,
      additionalAbortSignals: [parentA.signal, parentB.signal],
    });
    disposables.push(ks);
    parentB.abort();
    expect(ks.tripped).toBe(true);
    expect(ks.trippedBy).toBe('parent-signal');
    // Further parent aborts are no-ops; trigger stays at its
    // first-seen value.
    parentA.abort();
    expect(ks.trippedBy).toBe('parent-signal');
  });

  it('only trips once even if multiple paths fire', async () => {
    const parent = new AbortController();
    const ks = createKillSwitch({
      stateDir,
      additionalAbortSignals: [parent.signal],
      pollFallbackMs: 30,
    });
    disposables.push(ks);
    // Fire sentinel first, then parent. The second should be a no-op.
    writeFileSync(join(stateDir, 'STOP'), '');
    for (let i = 0; i < 20 && !ks.tripped; i++) await delay(20);
    expect(ks.tripped).toBe(true);
    const firstTrigger = ks.trippedBy;
    parent.abort();
    expect(ks.trippedBy).toBe(firstTrigger);
  });

  it('dispose is idempotent and does not trip the signal', () => {
    const ks = createKillSwitch({ stateDir, pollFallbackMs: 50 });
    disposables.push(ks);
    expect(ks.signal.aborted).toBe(false);
    ks.dispose();
    ks.dispose(); // no throw
    expect(ks.signal.aborted).toBe(false);
  });

  it('dispose stops watching (post-dispose sentinel creation does NOT trip)', async () => {
    const ks = createKillSwitch({ stateDir, pollFallbackMs: 20 });
    disposables.push(ks);
    ks.dispose();
    writeFileSync(join(stateDir, 'STOP'), '');
    await delay(120);
    expect(ks.tripped).toBe(false);
    expect(ks.signal.aborted).toBe(false);
  });

  it('stops polling + watching after a trip (CPU hygiene)', async () => {
    const ks = createKillSwitch({ stateDir, pollFallbackMs: 20 });
    disposables.push(ks);
    writeFileSync(join(stateDir, 'STOP'), '');
    for (let i = 0; i < 20 && !ks.tripped; i++) await delay(20);
    expect(ks.tripped).toBe(true);
    // Remove + re-create: no change in state, no throw.
    rmSync(join(stateDir, 'STOP'));
    writeFileSync(join(stateDir, 'STOP'), '');
    await delay(80);
    // Still tripped, trigger unchanged.
    expect(ks.trippedBy).toBe('stop-sentinel');
  });

  it('signal.reason is a KillSwitchAbortReason with the right trigger', async () => {
    const parent = new AbortController();
    const ks = createKillSwitch({
      stateDir,
      additionalAbortSignals: [parent.signal],
    });
    disposables.push(ks);
    parent.abort();
    expect(isKillSwitchAbortReason(ks.signal.reason)).toBe(true);
    const reason = ks.signal.reason as { trigger: string; trippedAt: string };
    expect(reason.trigger).toBe('parent-signal');
    expect(typeof reason.trippedAt).toBe('string');
    expect(() => new Date(reason.trippedAt).toISOString()).not.toThrow();
  });

  it('isKillSwitchAbortReason returns false for unrelated abort reasons', () => {
    expect(isKillSwitchAbortReason(undefined)).toBe(false);
    expect(isKillSwitchAbortReason(null)).toBe(false);
    expect(isKillSwitchAbortReason('a string')).toBe(false);
    expect(isKillSwitchAbortReason({ kind: 'deadline' })).toBe(false);
    expect(isKillSwitchAbortReason(new Error('x'))).toBe(false);
  });
});
