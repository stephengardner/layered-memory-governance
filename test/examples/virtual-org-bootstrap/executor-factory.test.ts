/**
 * executor-factory composition tests.
 *
 * `createVirtualOrgCodeAuthorFn` wraps `buildDiffBasedCodeAuthorExecutor`
 * + `runCodeAuthor` behind a signature the agent-sdk executor seam
 * accepts as `codeAuthorFn`. These tests pin the wiring:
 *   - the returned fn forwards (host, payload, correlationId, options)
 *     to runCodeAuthor
 *   - the injected executor is what buildDiffBasedCodeAuthorExecutor
 *     returns (not a fresh stub synthesized inside the fn)
 *   - caller-supplied options (signal, principalId) are preserved.
 */

import { describe, expect, it, vi } from 'vitest';
import { afterEach } from 'vitest';

import * as execDiffBased from '../../../src/runtime/actor-message/diff-based-code-author-executor.js';
import * as invoker from '../../../src/runtime/actor-message/code-author-invoker.js';
import type { Host } from '../../../src/substrate/interface.js';

import {
  createVirtualOrgCodeAuthorFn,
} from '../../../src/examples/virtual-org-bootstrap/executor-factory.js';

// A deliberately half-built Host stub -- the wrapper under test
// forwards to runCodeAuthor, which is itself mocked, so nothing below
// reads these sub-interfaces.
const fakeHost = {} as Host;
const fakeGhClient = { rest: vi.fn(), graphql: vi.fn(), executor: vi.fn(), raw: vi.fn() } as unknown as Parameters<typeof createVirtualOrgCodeAuthorFn>[0]['ghClient'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createVirtualOrgCodeAuthorFn', () => {
  it('builds the diff-based executor once and forwards it to runCodeAuthor on each invocation', async () => {
    const fakeExecutor = { execute: vi.fn() } as unknown as ReturnType<typeof execDiffBased.buildDiffBasedCodeAuthorExecutor>;
    const buildSpy = vi
      .spyOn(execDiffBased, 'buildDiffBasedCodeAuthorExecutor')
      .mockReturnValue(fakeExecutor);
    const runSpy = vi
      .spyOn(invoker, 'runCodeAuthor')
      .mockResolvedValue({ kind: 'completed', producedAtomIds: [], summary: 'ok' });

    const fn = createVirtualOrgCodeAuthorFn({
      host: fakeHost,
      ghClient: fakeGhClient,
      owner: 'stephengardner',
      repo: 'layered-autonomous-governance',
      repoDir: '/repo',
      gitIdentity: { name: 'lag-ceo[bot]', email: 'lag-ceo@users.noreply.github.com' },
      model: 'claude-opus-4-7',
    });

    await fn(fakeHost, { plan_id: 'plan-1' }, 'corr-A');
    await fn(fakeHost, { plan_id: 'plan-2' }, 'corr-B');

    // Executor is built once at factory time; every invocation reuses it.
    expect(buildSpy).toHaveBeenCalledTimes(1);
    const builtConfig = buildSpy.mock.calls[0]![0];
    expect(builtConfig.ghClient).toBe(fakeGhClient);
    expect(builtConfig.owner).toBe('stephengardner');
    expect(builtConfig.repo).toBe('layered-autonomous-governance');
    expect(builtConfig.repoDir).toBe('/repo');
    expect(builtConfig.model).toBe('claude-opus-4-7');
    expect(builtConfig.gitIdentity.name).toBe('lag-ceo[bot]');
    expect(builtConfig.host).toBe(fakeHost);

    expect(runSpy).toHaveBeenCalledTimes(2);
    const firstCall = runSpy.mock.calls[0]!;
    expect(firstCall[0]).toBe(fakeHost);
    expect(firstCall[1]).toEqual({ plan_id: 'plan-1' });
    expect(firstCall[2]).toBe('corr-A');
    expect(firstCall[3]?.executor).toBe(fakeExecutor);
  });

  it('merges caller-supplied options (signal, principalId) into the runCodeAuthor options bag', async () => {
    const fakeExecutor = { execute: vi.fn() } as unknown as ReturnType<typeof execDiffBased.buildDiffBasedCodeAuthorExecutor>;
    vi.spyOn(execDiffBased, 'buildDiffBasedCodeAuthorExecutor').mockReturnValue(fakeExecutor);
    const runSpy = vi
      .spyOn(invoker, 'runCodeAuthor')
      .mockResolvedValue({ kind: 'completed', producedAtomIds: [], summary: 'ok' });

    const fn = createVirtualOrgCodeAuthorFn({
      host: fakeHost,
      ghClient: fakeGhClient,
      owner: 'o',
      repo: 'r',
      repoDir: '/d',
      gitIdentity: { name: 'n', email: 'e' },
      model: 'm',
    });

    const signal = new AbortController().signal;
    await fn(fakeHost, { plan_id: 'plan-x' }, 'corr', {
      signal,
      principalId: 'custom-principal' as never,
    });

    const opts = runSpy.mock.calls[0]![3]!;
    expect(opts.executor).toBe(fakeExecutor);
    expect(opts.signal).toBe(signal);
    expect(opts.principalId).toBe('custom-principal');
  });
});
