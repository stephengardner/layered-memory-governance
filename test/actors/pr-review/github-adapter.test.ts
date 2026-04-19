/**
 * GitHubPrReviewAdapter tests (Phase 53a.1).
 *
 * Uses a stub GhClient to assert adapter behavior end-to-end:
 *   - listUnresolvedComments: paginates, filters resolved/outdated,
 *     preserves threadId
 *   - replyToComment: POSTs to the replies endpoint with body field
 *   - resolveComment: looks up threadId (cached or via re-list) and
 *     calls the resolveReviewThread mutation
 *   - dryRun mode: writes short-circuit without shelling out; reads still go through
 *   - resolveComment throws when thread cannot be found
 */

import { describe, expect, it } from 'vitest';
import { GitHubPrReviewAdapter } from '../../../src/actors/pr-review/github.js';
import type { GhClient, GhExecResult, GhRestArgs } from '../../../src/external/github/gh-client.js';
import type { PrIdentifier } from '../../../src/actors/pr-review/adapter.js';

const PR: PrIdentifier = { owner: 'o', repo: 'r', number: 1 };

interface RestCall { readonly args: GhRestArgs; }
interface GraphqlCall { readonly query: string; readonly vars: Record<string, unknown>; }

interface StubClient extends GhClient {
  readonly rests: RestCall[];
  readonly graphqls: GraphqlCall[];
}

function mkClient(responses: {
  readonly rest?: ReadonlyArray<unknown>;
  readonly graphql?: ReadonlyArray<unknown>;
}): StubClient {
  const rests: RestCall[] = [];
  const graphqls: GraphqlCall[] = [];
  let restI = 0;
  let gqlI = 0;
  const client: StubClient = {
    executor: async () => ({ stdout: '', stderr: '', exitCode: 0 } satisfies GhExecResult),
    rests,
    graphqls,
    async rest<T>(args: GhRestArgs): Promise<T> {
      rests.push({ args });
      const r = (responses.rest ?? [])[restI++];
      return r as T;
    },
    async graphql<T>(query: string, vars: Record<string, unknown> = {}): Promise<T> {
      graphqls.push({ query, vars });
      const r = (responses.graphql ?? [])[gqlI++];
      return r as T;
    },
    async raw(): Promise<GhExecResult> {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  return client;
}

function mkThreadsPage(
  threads: ReadonlyArray<{
    id: string;
    isResolved?: boolean;
    isOutdated?: boolean;
    path?: string;
    comments: ReadonlyArray<{ databaseId: number; body: string; author?: string; line?: number }>;
  }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo,
          nodes: threads.map((t) => ({
            id: t.id,
            isResolved: t.isResolved ?? false,
            isOutdated: t.isOutdated ?? false,
            path: t.path,
            comments: {
              nodes: t.comments.map((c) => ({
                id: `gqlid_${c.databaseId}`,
                databaseId: c.databaseId,
                author: c.author ? { login: c.author } : undefined,
                body: c.body,
                path: t.path,
                line: c.line ?? null,
                createdAt: '2026-04-19T00:00:00Z',
              })),
            },
          })),
        },
      },
    },
  };
}

describe('GitHubPrReviewAdapter', () => {
  it('listUnresolvedComments filters resolved and outdated threads', async () => {
    const client = mkClient({
      graphql: [
        mkThreadsPage([
          { id: 't1', comments: [{ databaseId: 101, body: 'live nit', author: 'coderabbitai' }] },
          { id: 't2', isResolved: true, comments: [{ databaseId: 102, body: 'skip (resolved)' }] },
          { id: 't3', isOutdated: true, comments: [{ databaseId: 103, body: 'skip (outdated)' }] },
        ]),
      ],
    });
    const adapter = new GitHubPrReviewAdapter({ client });
    const comments = await adapter.listUnresolvedComments(PR);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe('101');
    expect(comments[0]!.author).toBe('coderabbitai');
    expect(comments[0]!.threadId).toBe('t1');
  });

  it('listUnresolvedComments paginates until hasNextPage=false', async () => {
    const client = mkClient({
      graphql: [
        mkThreadsPage(
          [{ id: 'tA', comments: [{ databaseId: 201, body: 'page1' }] }],
          { hasNextPage: true, endCursor: 'cursor1' },
        ),
        mkThreadsPage([{ id: 'tB', comments: [{ databaseId: 202, body: 'page2' }] }]),
      ],
    });
    const adapter = new GitHubPrReviewAdapter({ client });
    const comments = await adapter.listUnresolvedComments(PR);
    expect(comments).toHaveLength(2);
    expect(client.graphqls).toHaveLength(2);
    expect(client.graphqls[1]!.vars.cursor).toBe('cursor1');
  });

  it('replyToComment POSTs to the replies endpoint with body field', async () => {
    const client = mkClient({ rest: [{ id: 7777, node_id: 'node7', body: 'thanks' }] });
    const adapter = new GitHubPrReviewAdapter({ client });
    const outcome = await adapter.replyToComment(PR, '101', 'thanks');
    expect(outcome.posted).toBe(true);
    expect(outcome.replyId).toBe('7777');
    expect(client.rests[0]!.args.method).toBe('POST');
    expect(client.rests[0]!.args.path).toBe('repos/o/r/pulls/1/comments/101/replies');
    expect(client.rests[0]!.args.fields).toEqual({ body: 'thanks' });
  });

  it('resolveComment uses cached threadId after a list call', async () => {
    const client = mkClient({
      graphql: [
        mkThreadsPage([{ id: 't1', comments: [{ databaseId: 101, body: 'live nit' }] }]),
        { resolveReviewThread: { thread: { id: 't1', isResolved: true } } },
      ],
    });
    const adapter = new GitHubPrReviewAdapter({ client });
    await adapter.listUnresolvedComments(PR);
    await adapter.resolveComment(PR, '101');
    const resolveCall = client.graphqls.find((c) => c.query.includes('resolveReviewThread'));
    expect(resolveCall).toBeDefined();
    expect(resolveCall!.vars.threadId).toBe('t1');
  });

  it('resolveComment re-lists when threadId is not yet cached', async () => {
    const client = mkClient({
      graphql: [
        mkThreadsPage([{ id: 't1', comments: [{ databaseId: 101, body: 'live nit' }] }]),
        { resolveReviewThread: { thread: { id: 't1', isResolved: true } } },
      ],
    });
    const adapter = new GitHubPrReviewAdapter({ client });
    await adapter.resolveComment(PR, '101');
    expect(client.graphqls).toHaveLength(2);
  });

  it('resolveComment throws when no thread can be found', async () => {
    const client = mkClient({
      graphql: [mkThreadsPage([{ id: 't1', comments: [{ databaseId: 101, body: 'x' }] }])],
    });
    const adapter = new GitHubPrReviewAdapter({ client });
    await expect(adapter.resolveComment(PR, '999')).rejects.toThrow(/no thread found/);
  });

  it('dryRun: replyToComment short-circuits without calling the client', async () => {
    const client = mkClient({});
    const adapter = new GitHubPrReviewAdapter({ client, dryRun: true });
    const outcome = await adapter.replyToComment(PR, '101', 'thanks');
    expect(outcome.posted).toBe(false);
    expect(outcome.dryRun).toBe(true);
    expect(client.rests).toHaveLength(0);
  });

  it('dryRun: resolveComment short-circuits without calling the client', async () => {
    const client = mkClient({});
    const adapter = new GitHubPrReviewAdapter({ client, dryRun: true });
    await adapter.resolveComment(PR, '101');
    expect(client.graphqls).toHaveLength(0);
  });

  it('dryRun: listUnresolvedComments still hits the client (reads are not gated)', async () => {
    const client = mkClient({
      graphql: [mkThreadsPage([{ id: 't1', comments: [{ databaseId: 101, body: 'nit' }] }])],
    });
    const adapter = new GitHubPrReviewAdapter({ client, dryRun: true });
    const comments = await adapter.listUnresolvedComments(PR);
    expect(comments).toHaveLength(1);
    expect(client.graphqls).toHaveLength(1);
  });
});
