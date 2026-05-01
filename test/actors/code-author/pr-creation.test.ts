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
  EMBEDDED_ATOMS_HEADING,
  PrCreationError,
  buildEmbeddedAtomSnapshots,
  createDraftPr,
  renderEmbeddedAtomBlock,
  renderPrBody,
} from '../../../src/actors/code-author/pr-creation.js';
import type { GhClient } from '../../../src/external/github/index.js';
import type { Host } from '../../../src/interface.js';
import type { Atom } from '../../../src/types.js';

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

describe('renderPrBody (embedded atom snapshots)', () => {
  // The embedded-atom block is the LAG-auditor carrier per the
  // CI-runner gap fix: workflow runs on a runner with no
  // .lag/atoms/ directory and no named tunnel, so the body is the
  // only source of truth the auditor can resolve from. The block
  // shape must round-trip through parseEmbeddedAtomFromPrBody in
  // scripts/lib/autonomous-dispatch-exec.mjs; the parser side has
  // its own coverage in test/scripts/autonomous-dispatch-exec.test.ts.
  function baseInputs() {
    return {
      planId: 'plan-x',
      planContent: 'plan',
      draftNotes: '',
      draftConfidence: 0,
      observationAtomId: 'obs',
      commitSha: 'sha',
      costUsd: 0,
      modelUsed: 'm',
      touchedPaths: [] as ReadonlyArray<string>,
    };
  }

  it('omits the embedded-atoms section when no snapshots are passed (back-compat for existing callers)', () => {
    const body = renderPrBody({ ...baseInputs() });
    expect(body).not.toContain(EMBEDDED_ATOMS_HEADING);
    expect(body).not.toContain('<details><summary>atom:');
  });

  it('emits one <details> block per embedded snapshot under the canonical heading', () => {
    const body = renderPrBody({
      ...baseInputs(),
      embeddedAtoms: [
        { id: 'plan-x', json: '{"id":"plan-x","type":"plan"}' },
        { id: 'intent-y', json: '{"id":"intent-y","type":"operator-intent"}' },
      ],
    });
    expect(body).toContain(EMBEDDED_ATOMS_HEADING);
    expect(body).toContain('<details><summary>atom: plan-x</summary>');
    expect(body).toContain('<details><summary>atom: intent-y</summary>');
    // Both JSON payloads survive verbatim inside their fenced
    // blocks so the parser's id-mismatch guard has the canonical
    // payload to compare against.
    expect(body).toContain('{"id":"plan-x","type":"plan"}');
    expect(body).toContain('{"id":"intent-y","type":"operator-intent"}');
  });

  it('renders the embedded-atoms section AFTER the YAML provenance footer', () => {
    // Body order matters because the parser anchors to the section
    // heading; if the renderer ever puts embedded blocks BEFORE
    // the YAML footer, a stray <details> in the truncated plan
    // content slice could shadow the carrier section. Pin the
    // order explicitly.
    const body = renderPrBody({
      ...baseInputs(),
      embeddedAtoms: [{ id: 'plan-x', json: '{"id":"plan-x"}' }],
    });
    const footerIdx = body.indexOf('```yaml');
    const sectionIdx = body.indexOf(EMBEDDED_ATOMS_HEADING);
    expect(footerIdx).toBeGreaterThan(0);
    expect(sectionIdx).toBeGreaterThan(footerIdx);
  });

  it('escapes <, >, & in the rendered <summary> text without affecting the JSON payload', () => {
    // A summary id with literal angle brackets would corrupt the
    // surrounding HTML on GitHub's renderer. The summary is
    // display-only; the JSON payload's `id` field is the canonical
    // identifier the parser compares against, so the JSON itself
    // is NOT escaped (the parser would refuse to parse `&lt;`).
    const body = renderPrBody({
      ...baseInputs(),
      embeddedAtoms: [{
        id: 'plan-<script>',
        json: '{"id":"plan-<script>"}',
      }],
    });
    expect(body).toContain('<details><summary>atom: plan-&lt;script&gt;</summary>');
    expect(body).toContain('{"id":"plan-<script>"}');
  });

  it('truncates a snapshot above the per-atom JSON cap with an unparseable trailer', () => {
    // The cap is 16384 chars per atom snapshot. An over-cap atom
    // gets truncated AND a /* truncated */ marker is appended that
    // makes the JSON unparseable on the consumer side. The auditor's
    // not-found fallback path then kicks in instead of silently
    // using a half-cropped atom.
    const huge = '"' + 'a'.repeat(20_000) + '"';
    const body = renderPrBody({
      ...baseInputs(),
      embeddedAtoms: [{ id: 'huge', json: `{"id":"huge","content":${huge}}` }],
    });
    expect(body).toContain('truncated at 16384 chars');
    // The trailer is a JSON-comment-shaped marker (not a valid JSON
    // suffix) so JSON.parse on the truncated payload fails, which
    // is the intended degraded behaviour.
    expect(() => JSON.parse(body.slice(body.indexOf('```json') + 7, body.lastIndexOf('```')))).toThrow();
  });
});

describe('buildEmbeddedAtomSnapshots', () => {
  // Walks plan.provenance.derived_from to find the operator-intent
  // atom and ships {plan, intent}. The function is the single
  // shared helper both executors (agentic + diff-based) call to
  // build the embedded-atoms list, so both code paths produce the
  // same body shape.
  function makeHost(atoms: ReadonlyArray<Atom>): Host {
    const byId = new Map(atoms.map((a) => [a.id, a]));
    return {
      atoms: {
        get: async (id: string) => byId.get(id) ?? null,
      },
    } as unknown as Host;
  }

  function makeAtom(id: string, type: string, derivedFrom: ReadonlyArray<string> = []): Atom {
    return {
      schema_version: 1,
      id,
      type: type as Atom['type'],
      layer: 'L1',
      principal_id: 'p',
      provenance: {
        kind: 'agent-claimed',
        source: { agent_id: 'p' },
        derived_from: [...derivedFrom],
      },
      confidence: 1,
      scope: 'project',
      content: '',
      metadata: {},
      created_at: '2026-04-30T12:00:00.000Z',
      last_reinforced_at: '2026-04-30T12:00:00.000Z',
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      taint: 'clean',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    } as Atom;
  }

  it('returns plan + operator-intent snapshots when both are reachable', async () => {
    const intent = makeAtom('intent-1', 'operator-intent');
    const plan = makeAtom('plan-1', 'plan', ['intent-1']);
    const host = makeHost([intent, plan]);
    const out = await buildEmbeddedAtomSnapshots(host, plan);
    expect(out.length).toBe(2);
    expect(out[0].id).toBe('plan-1');
    expect(out[1].id).toBe('intent-1');
    // Plan first matches the body's "primary lookup hits a snapshot
    // before walking provenance" ordering rationale.
    expect(JSON.parse(out[0].json).type).toBe('plan');
    expect(JSON.parse(out[1].json).type).toBe('operator-intent');
  });

  it('emits no snapshots for a plan with no operator-intent in derived_from', async () => {
    // Plans that are not intent-driven do not get an embedded
    // carrier section: the auditor's "no operator-intent in
    // provenance" exit covers the non-intent case, and emitting
    // an empty list keeps the body surface narrow (per CR
    // finding: every code-author PR was getting a carrier
    // before, contradicting the function's intent-driven contract).
    const plan = makeAtom('plan-1', 'plan', []);
    const host = makeHost([plan]);
    const out = await buildEmbeddedAtomSnapshots(host, plan);
    expect(out.length).toBe(0);
  });

  it('emits no snapshots when the intent reference is unreachable (atom store returns null)', async () => {
    // The dispatch flow may run on a host where the operator-intent
    // atom was reaped or relocated; building snapshots must not
    // throw and must not emit a half-carrier (plan with no intent),
    // which the auditor would treat as a non-intent plan anyway.
    const plan = makeAtom('plan-1', 'plan', ['intent-missing']);
    const host = makeHost([plan]);
    const out = await buildEmbeddedAtomSnapshots(host, plan);
    expect(out.length).toBe(0);
  });

  it('round-trips: render -> parse via the script-side helper recovers the atom', async () => {
    // End-to-end round-trip exercising the full chain
    // (buildEmbeddedAtomSnapshots -> renderPrBody -> [body wire] ->
    // parseEmbeddedAtomFromPrBody) so a future drift between the
    // renderer and the parser fails this test loudly.
    const { parseEmbeddedAtomFromPrBody } = await import(
      '../../../scripts/lib/autonomous-dispatch-exec.mjs'
    );
    const intent = makeAtom('intent-rt', 'operator-intent');
    const plan = makeAtom('plan-rt', 'plan', ['intent-rt']);
    const host = makeHost([intent, plan]);
    const embeddedAtoms = await buildEmbeddedAtomSnapshots(host, plan);
    const body = renderPrBody({
      planId: 'plan-rt', planContent: '', draftNotes: '', draftConfidence: 0,
      observationAtomId: 'obs', commitSha: 'sha', costUsd: 0, modelUsed: 'm',
      touchedPaths: [], embeddedAtoms,
    });
    const parsedPlan = parseEmbeddedAtomFromPrBody(body, 'plan-rt');
    const parsedIntent = parseEmbeddedAtomFromPrBody(body, 'intent-rt');
    expect(parsedPlan?.id).toBe('plan-rt');
    expect(parsedPlan?.type).toBe('plan');
    expect(parsedIntent?.id).toBe('intent-rt');
    expect(parsedIntent?.type).toBe('operator-intent');
  });
});

describe('renderEmbeddedAtomBlock', () => {
  // Pure rendering surface; covered alongside renderPrBody but
  // exposed independently for the unit-level guard against
  // accidental drift in the block shape.
  it('produces the canonical block shape (summary + json fence + closer)', () => {
    const out = renderEmbeddedAtomBlock({ id: 'a-1', json: '{"id":"a-1"}' });
    expect(out).toContain('<details><summary>atom: a-1</summary>');
    expect(out).toContain('```json');
    expect(out).toContain('{"id":"a-1"}');
    expect(out).toContain('</details>');
  });
});
