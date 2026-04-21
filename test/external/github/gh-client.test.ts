/**
 * GhClient tests (Phase 53a.1).
 *
 * Uses a stub GhExecutor to assert on:
 *   - REST call shape (method, path, --field flags, query string)
 *   - GraphQL call shape (query + vars)
 *   - JSON parsing
 *   - GhClientError on non-zero exit
 *   - GhClientError when GraphQL returns {errors: [...]}
 *   - raw() passes args through and throws on non-zero
 */

import { describe, expect, it } from 'vitest';
import { createGhClient } from '../../../src/external/github/gh-client.js';
import type { GhExecResult, GhExecutor } from '../../../src/external/github/gh-client.js';

interface RecordedCall {
  readonly args: ReadonlyArray<string>;
  readonly stdin: string | undefined;
  readonly signal: AbortSignal | undefined;
}

function mkStub(responses: ReadonlyArray<GhExecResult>): {
  executor: GhExecutor;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const executor: GhExecutor = async (args, options) => {
    calls.push({ args, stdin: options?.stdin, signal: options?.signal });
    const result = responses[i] ?? { stdout: '', stderr: '', exitCode: 0 };
    i++;
    return result;
  };
  return { executor, calls };
}

describe('createGhClient', () => {
  it('rest: builds `gh api PATH --method GET` for defaults', async () => {
    const { executor, calls } = mkStub([{ stdout: '{"id": 1}', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    const result = await client.rest<{ id: number }>({ path: 'repos/a/b' });
    expect(result.id).toBe(1);
    expect(calls[0]!.args).toEqual(['api', 'repos/a/b', '--method', 'GET']);
  });

  it('rest: adds query string params on GET', async () => {
    const { executor, calls } = mkStub([{ stdout: '[]', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    await client.rest({ path: 'repos/a/b/pulls', query: { state: 'open', per_page: 5 } });
    const path = calls[0]!.args[1]!;
    expect(path).toContain('state=open');
    expect(path).toContain('per_page=5');
  });

  it('rest: string bodies use --raw-field so a leading @ is not treated as a file path', async () => {
    // Regression guard. When the body value starts with "@" (e.g.
    // "@coderabbitai review"), `gh api --field` interprets it as
    // "read from file named 'coderabbitai review'" and the request
    // fails with ENOENT. `--raw-field` always treats the value as a
    // literal string.
    const { executor, calls } = mkStub([{ stdout: '{"id": 42}', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    await client.rest({
      method: 'POST',
      path: 'repos/a/b/pulls/1/comments/99/replies',
      fields: { body: '@coderabbitai review' },
    });
    expect(calls[0]!.args).toContain('--raw-field');
    expect(calls[0]!.args).toContain('body=@coderabbitai review');
    expect(calls[0]!.args).not.toContain('--field');
    expect(calls[0]!.args).toContain('--method');
    expect(calls[0]!.args[calls[0]!.args.indexOf('--method') + 1]).toBe('POST');
  });

  it('rest: numeric + boolean fields still use --field so gh preserves the JSON type', async () => {
    const { executor, calls } = mkStub([{ stdout: '{"ok": true}', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    await client.rest({
      method: 'POST',
      path: 'repos/a/b/x',
      fields: { count: 3, flag: true },
    });
    const args = calls[0]!.args;
    const countIdx = args.indexOf('count=3');
    expect(countIdx).toBeGreaterThan(-1);
    expect(args[countIdx - 1]).toBe('--field');
    const flagIdx = args.indexOf('flag=true');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(args[flagIdx - 1]).toBe('--field');
  });

  it('graphql: passes query and raw-field variables', async () => {
    const { executor, calls } = mkStub([
      { stdout: '{"data":{"hello":"world"}}', stderr: '', exitCode: 0 },
    ]);
    const client = createGhClient({ executor });
    const data = await client.graphql<{ hello: string }>(
      'query { hello }',
      { number: 1, owner: 'foo', flag: true, nothing: null },
    );
    expect(data.hello).toBe('world');
    expect(calls[0]!.args[0]).toBe('api');
    expect(calls[0]!.args[1]).toBe('graphql');
    // Query goes through --raw-field so gh does not try to JSON-parse it.
    expect(calls[0]!.args).toContain('--raw-field');
    expect(calls[0]!.args).toContain('query=query { hello }');
    // Strings: --raw-field (bare value; gh sends as JSON string on the wire).
    // Numbers / booleans / null: -F with bare literal (JSON-typed).
    const args = calls[0]!.args;
    const expectations: ReadonlyArray<{ pair: string; flag: string }> = [
      { pair: 'number=1', flag: '-F' },
      { pair: 'owner=foo', flag: '--raw-field' },
      { pair: 'flag=true', flag: '-F' },
      { pair: 'nothing=null', flag: '-F' },
    ];
    for (const { pair, flag } of expectations) {
      const idx = args.indexOf(pair);
      expect(idx, `expected "${pair}" in args: ${JSON.stringify(args)}`).toBeGreaterThan(-1);
      expect(args[idx - 1]).toBe(flag);
    }
  });

  it('graphql: throws GhClientError when response has errors', async () => {
    const { executor } = mkStub([
      {
        stdout: '{"data":null,"errors":[{"message":"nope"}]}',
        stderr: '',
        exitCode: 0,
      },
    ]);
    const client = createGhClient({ executor });
    await expect(client.graphql('query { x }')).rejects.toThrow(/GraphQL returned errors: nope/);
  });

  it('raw: throws GhClientError on non-zero exit', async () => {
    const { executor } = mkStub([{ stdout: '', stderr: 'not authenticated', exitCode: 1 }]);
    const client = createGhClient({ executor });
    await expect(client.raw(['auth', 'status'])).rejects.toThrow(/not authenticated/);
  });

  it('rest: non-zero exit becomes GhClientError', async () => {
    const { executor } = mkStub([{ stdout: '', stderr: '404 Not Found', exitCode: 1 }]);
    const client = createGhClient({ executor });
    await expect(client.rest({ path: 'repos/a/b/pulls/99999' })).rejects.toThrow(/404/);
  });

  it('parses empty stdout as undefined (matches gh contract for 204)', async () => {
    const { executor } = mkStub([{ stdout: '', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    const result = await client.rest<unknown>({ method: 'DELETE', path: 'repos/a/b/issues/1' });
    expect(result).toBeUndefined();
  });

  it('signal: per-call signal is forwarded to the executor', async () => {
    const { executor, calls } = mkStub([{ stdout: '{}', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    const ac = new AbortController();
    await client.rest({ path: 'repos/a/b/pulls/1', signal: ac.signal });
    expect(calls[0]!.signal).toBe(ac.signal);
  });

  it('signal: client-level signal applies to every call by default', async () => {
    const { executor, calls } = mkStub([
      { stdout: '{}', stderr: '', exitCode: 0 },
      { stdout: '{"data":{}}', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
    ]);
    const ac = new AbortController();
    const client = createGhClient({ executor, signal: ac.signal });
    await client.rest({ path: 'r/a/b/pulls/1' });
    await client.graphql('query { viewer { login } }');
    await client.raw(['repo', 'view']);
    expect(calls[0]!.signal).toBe(ac.signal);
    expect(calls[1]!.signal).toBe(ac.signal);
    expect(calls[2]!.signal).toBe(ac.signal);
  });

  it('signal: per-call signal wins over client-level signal', async () => {
    const { executor, calls } = mkStub([{ stdout: '{}', stderr: '', exitCode: 0 }]);
    const clientSig = new AbortController().signal;
    const perCallSig = new AbortController().signal;
    const client = createGhClient({ executor, signal: clientSig });
    await client.rest({ path: 'r/a/b', signal: perCallSig });
    expect(calls[0]!.signal).toBe(perCallSig);
    expect(calls[0]!.signal).not.toBe(clientSig);
  });

  it('signal: no signal anywhere = no signal on the executor call', async () => {
    const { executor, calls } = mkStub([{ stdout: '{}', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    await client.rest({ path: 'r/a/b' });
    expect(calls[0]!.signal).toBeUndefined();
  });

  it('signal: graphql forwards per-call signal', async () => {
    const { executor, calls } = mkStub([{ stdout: '{"data":{}}', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    const ac = new AbortController();
    await client.graphql('query { x }', {}, { signal: ac.signal });
    expect(calls[0]!.signal).toBe(ac.signal);
  });

  it('signal: raw forwards per-call signal', async () => {
    const { executor, calls } = mkStub([{ stdout: 'ok', stderr: '', exitCode: 0 }]);
    const client = createGhClient({ executor });
    const ac = new AbortController();
    await client.raw(['repo', 'view'], { signal: ac.signal });
    expect(calls[0]!.signal).toBe(ac.signal);
  });
});
