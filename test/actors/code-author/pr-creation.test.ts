/**
 * Unit tests for createDraftPr + renderPrBody.
 *
 * Uses an injected GhClient stub (no real subprocess). Verifies:
 *   - happy path returns the typed PR result
 *   - missing owner/repo -> missing-owner-repo
 *   - client throws -> gh-api-failed
 *   - empty response -> invalid-response
 *   - response missing fields -> invalid-response
 *   - renderPrBody includes the machine-parseable footer with
 *     plan_id + observation_atom_id + commit_sha
 */

import { describe, expect, it } from 'vitest';
import {
  PrCreationError,
  createDraftPr,
  renderPrBody,
} from '../../../src/actors/code-author/pr-creation.js';
import type { GhClient } from '../../../src/external/github/index.js';

function stubClient(restImpl: GhClient['rest']): GhClient {
  return {
    rest: restImpl,
    graphql: (async () => { throw new Error('graphql not stubbed'); }) as GhClient['graphql'],
    raw: (async () => { throw new Error('raw not stubbed'); }) as GhClient['raw'],
  };
}

describe('createDraftPr', () => {
  it('happy path returns typed PR result', async () => {
    const client = stubClient((async () => ({
      number: 42,
      html_url: 'https://github.com/o/r/pull/42',
      url: 'https://api.github.com/repos/o/r/pulls/42',
      node_id: 'PR_kw123',
      state: 'open',
    })) as GhClient['rest']);
    const result = await createDraftPr({
      client,
      owner: 'o',
      repo: 'r',
      title: 'test',
      body: 'body',
      head: 'code-author/plan-1',
    });
    expect(result.number).toBe(42);
    expect(result.htmlUrl).toBe('https://github.com/o/r/pull/42');
    expect(result.state).toBe('open');
  });

  it('missing owner -> missing-owner-repo', async () => {
    const client = stubClient((async () => undefined) as GhClient['rest']);
    await expect(createDraftPr({
      client, owner: '', repo: 'r', title: 't', body: 'b', head: 'h',
    })).rejects.toMatchObject({ name: 'PrCreationError', reason: 'missing-owner-repo' });
  });

  it('whitespace-only owner -> missing-owner-repo', async () => {
    const client = stubClient((async () => undefined) as GhClient['rest']);
    await expect(createDraftPr({
      client, owner: '   ', repo: 'r', title: 't', body: 'b', head: 'h',
    })).rejects.toMatchObject({ name: 'PrCreationError', reason: 'missing-owner-repo' });
  });

  it('missing repo -> missing-owner-repo', async () => {
    const client = stubClient((async () => undefined) as GhClient['rest']);
    await expect(createDraftPr({
      client, owner: 'o', repo: '', title: 't', body: 'b', head: 'h',
    })).rejects.toMatchObject({ name: 'PrCreationError', reason: 'missing-owner-repo' });
  });

  it('whitespace-only repo -> missing-owner-repo', async () => {
    const client = stubClient((async () => undefined) as GhClient['rest']);
    await expect(createDraftPr({
      client, owner: 'o', repo: '\t\n', title: 't', body: 'b', head: 'h',
    })).rejects.toMatchObject({ name: 'PrCreationError', reason: 'missing-owner-repo' });
  });

  it('client throws -> gh-api-failed', async () => {
    const client = stubClient((async () => { throw new Error('gh boom'); }) as GhClient['rest']);
    await expect(createDraftPr({
      client, owner: 'o', repo: 'r', title: 't', body: 'b', head: 'h',
    })).rejects.toMatchObject({ name: 'PrCreationError', reason: 'gh-api-failed', stage: 'rest-call' });
  });

  it('preserves the original error via Error.cause', async () => {
    /*
     * CodeRabbit flagged that a raw new PrCreationError() loses the
     * GhClientError context (exitCode, stderr, args). Without those,
     * operators staring at a `gh-api-failed` have no path to root
     * cause. Regression: any future rewrite that drops `.cause`
     * must trip this test.
     */
    const original = Object.assign(new Error('gh boom'), { exitCode: 128, stderr: 'rate limit' });
    const client = stubClient((async () => { throw original; }) as GhClient['rest']);
    try {
      await createDraftPr({ client, owner: 'o', repo: 'r', title: 't', body: 'b', head: 'h' });
      throw new Error('expected PrCreationError');
    } catch (err) {
      expect((err as Error).name).toBe('PrCreationError');
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
      const cause = (err as Error & { cause?: Error & { exitCode?: number; stderr?: string } }).cause;
      expect(cause?.exitCode).toBe(128);
      expect(cause?.stderr).toBe('rate limit');
    }
  });

  it('empty response -> invalid-response', async () => {
    const client = stubClient((async () => undefined) as GhClient['rest']);
    await expect(createDraftPr({
      client, owner: 'o', repo: 'r', title: 't', body: 'b', head: 'h',
    })).rejects.toMatchObject({ name: 'PrCreationError', reason: 'invalid-response' });
  });

  it('response missing fields -> invalid-response', async () => {
    const client = stubClient((async () => ({ number: 42 })) as GhClient['rest']);
    await expect(createDraftPr({
      client, owner: 'o', repo: 'r', title: 't', body: 'b', head: 'h',
    })).rejects.toMatchObject({ name: 'PrCreationError', reason: 'invalid-response' });
  });

  it('body is passed through fields to the REST call', async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    const client = stubClient((async (args: Record<string, unknown>) => {
      capturedArgs = args;
      return {
        number: 1, html_url: 'x', url: 'y', node_id: 'z', state: 'open',
      };
    }) as GhClient['rest']);
    await createDraftPr({
      client, owner: 'o', repo: 'r',
      title: 'My PR', body: 'The body', head: 'feat/x',
    });
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!['method']).toBe('POST');
    expect(capturedArgs!['path']).toBe('repos/o/r/pulls');
    const fields = capturedArgs!['fields'] as Record<string, unknown>;
    expect(fields['title']).toBe('My PR');
    expect(fields['body']).toBe('The body');
    expect(fields['head']).toBe('feat/x');
    expect(fields['base']).toBe('main');
    expect(fields['draft']).toBe(true);
  });
});

describe('renderPrBody', () => {
  it('includes a machine-parseable footer with plan_id, observation_atom_id, commit_sha', () => {
    const body = renderPrBody({
      planId: 'plan-test-1',
      planContent: '# plan\n\nbody content',
      draftNotes: 'Bumped the version.',
      draftConfidence: 0.88,
      observationAtomId: 'code-author-invoked-plan-test-1-2026-04-21T00:00:00Z-abc123',
      commitSha: 'deadbeefcafe0011223344556677889900aabbcc',
      costUsd: 0.15,
      modelUsed: 'claude-opus-4-7',
      touchedPaths: ['README.md', 'package.json'],
    });
    expect(body).toContain('plan_id: "plan-test-1"');
    expect(body).toContain('commit_sha: "deadbeefcafe0011223344556677889900aabbcc"');
    expect(body).toContain('observation_atom_id: "code-author-invoked-plan-test-1-2026-04-21T00:00:00Z-abc123"');
    expect(body).toContain('Bumped the version.');
    expect(body).toContain('README.md');
    expect(body).toContain('package.json');
    expect(body).toContain('confidence: 0.88');
    expect(body).toContain('claude-opus-4-7');
  });

  it('truncates plan content at 4000 chars and bounds overall body length', () => {
    const long = 'a'.repeat(5000);
    const body = renderPrBody({
      planId: 'p', planContent: long,
      draftNotes: '', draftConfidence: 0.5,
      observationAtomId: 'o', commitSha: 'c',
      costUsd: 0, modelUsed: 'm',
      touchedPaths: [],
    });
    expect(body).toContain('...(plan truncated at 4000 chars)...');
    // The plan body slice is bounded at 4000 chars, so no run of
    // 4001 'a' should ever land in the rendered body. The entire body
    // must also fit inside a generous header/footer budget on top of
    // the 4000-char plan slice, which rules out runaway slicing.
    expect(body.match(/a{4001}/)).toBeNull();
    expect(body.length).toBeLessThan(4000 + 2000);
  });

  it('does not truncate when trailing whitespace makes raw length exceed cap but trimmed fits', () => {
    // 3900 real chars + 200 chars of trailing whitespace: raw length
    // 4100 > 4000, trimmed length 3900 <= 4000. The old code added a
    // spurious truncation marker; the fix checks the trimmed length.
    const padded = 'b'.repeat(3900) + ' '.repeat(200);
    const body = renderPrBody({
      planId: 'p', planContent: padded,
      draftNotes: '', draftConfidence: 0.5,
      observationAtomId: 'o', commitSha: 'c',
      costUsd: 0, modelUsed: 'm',
      touchedPaths: [],
    });
    expect(body).not.toContain('plan truncated');
  });

  it('machine-parseable footer survives ids containing newlines / colons / quotes', () => {
    // JSON.stringify on each scalar is what keeps the YAML valid if a
    // caller ever passes a malformed id. Without that defensive
    // quoting, a newline in the plan_id would break the YAML block
    // into two documents and silently lose the footer for downstream
    // observers.
    const body = renderPrBody({
      planId: 'plan: "1"\nmalicious: value',
      planContent: '',
      draftNotes: '',
      draftConfidence: 0,
      observationAtomId: 'obs\nwith\nnewlines',
      commitSha: 'sha: with colon',
      costUsd: 0, modelUsed: 'm',
      touchedPaths: [],
    });
    // The footer values must be JSON-encoded (quoted + backslash-escaped).
    expect(body).toContain('plan_id: "plan: \\"1\\"\\nmalicious: value"');
    expect(body).toContain('observation_atom_id: "obs\\nwith\\nnewlines"');
    expect(body).toContain('commit_sha: "sha: with colon"');
    // No literal newline inside the plan_id scalar.
    const footerIdx = body.indexOf('```yaml');
    const footerBlock = body.slice(footerIdx, body.indexOf('```', footerIdx + 7));
    // Raw newline inside a scalar would break the YAML block into
    // multiple lines per key; three keys must still be three lines.
    const nonEmptyLines = footerBlock.split('\n').filter((l) => l.trim().length > 0);
    expect(nonEmptyLines.length).toBe(4); // ```yaml + 3 keys
  });
});
