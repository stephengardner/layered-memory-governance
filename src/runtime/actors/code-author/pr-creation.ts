/**
 * PR creation primitive: open a pull request for a pushed branch.
 *
 * Pure mechanism. Takes an authenticated GitHub client + branch
 * handle + PR body fields, returns the opened PR's number + url
 * or throws `PrCreationError` on any fail-closed axis.
 *
 * Design note: this module does NOT know about atoms or fences.
 * Every piece of caller-specific metadata (plan id, observation
 * atom id, commit SHA) is passed in as a string and interpolated
 * into the PR body. Keeping this primitive caller-agnostic lets
 * the same function serve the native actor runtime, a LangGraph
 * node, or an ad-hoc script.
 */

import type { GhClient } from '../../../external/github/index.js';

export type PrCreationErrorReason =
  | 'missing-owner-repo'
  | 'gh-api-failed'
  | 'invalid-response';

export class PrCreationError extends Error {
  constructor(
    message: string,
    public readonly reason: PrCreationErrorReason,
    public readonly stage: string,
    public readonly status: number | null = null,
    public readonly responseBody: unknown = undefined,
  ) {
    super(message);
    this.name = 'PrCreationError';
  }
}

export interface CreatePrInputs {
  readonly client: GhClient;
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  /**
   * Full PR body. Caller is responsible for shaping the body;
   * typical content is the plan's title + content + a footer
   * linking the plan-atom id / observation-atom id / commit SHA
   * for downstream audit.
   */
  readonly body: string;
  /** Branch already pushed to `origin` via applyDraftBranch. */
  readonly head: string;
  /** Target branch; defaults to `main`. */
  readonly base?: string;
  /** Open as a draft PR by default so operator review is required. */
  readonly draft?: boolean;
}

export interface CreatePrResult {
  readonly number: number;
  readonly htmlUrl: string;
  readonly apiUrl: string;
  readonly nodeId: string;
  readonly state: string;
}

/**
 * Open a PR via the REST `pulls` endpoint. The caller pre-
 * authenticates `client` with whatever credentials are
 * appropriate for its identity story (App installation token,
 * PAT, etc); this function only plumbs those through.
 */
export async function createDraftPr(
  inputs: CreatePrInputs,
): Promise<CreatePrResult> {
  // Trim-aware check: a whitespace-only owner or repo would URL-encode
  // to `%20` and produce a nonsense `repos/ /r/pulls` path that the gh
  // REST client would happily POST to. Reject those client-side.
  if (!inputs.owner?.trim() || !inputs.repo?.trim()) {
    throw new PrCreationError(
      'owner + repo required',
      'missing-owner-repo',
      'validate-inputs',
    );
  }

  const base = inputs.base ?? 'main';
  const draft = inputs.draft ?? true;

  let resp;
  try {
    resp = await inputs.client.rest<{
      number: number;
      html_url: string;
      url: string;
      node_id: string;
      state: string;
    }>({
      method: 'POST',
      path: `repos/${inputs.owner}/${inputs.repo}/pulls`,
      fields: {
        title: inputs.title,
        head: inputs.head,
        base,
        body: inputs.body,
        draft,
      },
    });
  } catch (err) {
    /*
     * Preserve the full error chain via `cause`. `GhClientError`
     * carries exitCode/stderr/args that are the only actionable
     * diagnostic signal when a gh CLI call fails (rate limit,
     * 422 validation, token scope mismatch); discarding it would
     * leave debuggers staring at a generic "gh-api-failed" with
     * no path to root cause. Error.cause is ES2022 and propagates
     * through `toString`-style chains so it shows up in logs.
     */
    const reason = err instanceof Error ? err.message : String(err);
    const wrapped = new PrCreationError(
      `gh REST pulls create failed: ${reason}`,
      'gh-api-failed',
      'rest-call',
    );
    (wrapped as Error).cause = err;
    throw wrapped;
  }

  if (!resp) {
    throw new PrCreationError(
      'gh REST pulls create returned empty response',
      'invalid-response',
      'parse-response',
    );
  }

  if (
    typeof resp.number !== 'number'
    || typeof resp.html_url !== 'string'
    || typeof resp.url !== 'string'
    || typeof resp.node_id !== 'string'
    || typeof resp.state !== 'string'
  ) {
    throw new PrCreationError(
      'gh REST pulls create response missing required fields',
      'invalid-response',
      'parse-response',
      null,
      resp,
    );
  }

  return Object.freeze({
    number: resp.number,
    htmlUrl: resp.html_url,
    apiUrl: resp.url,
    nodeId: resp.node_id,
    state: resp.state,
  });
}

/**
 * Shape the PR body from a plan atom, observation id, and commit
 * metadata. Keeps body construction here (with the other PR
 * primitives) rather than scattered across every caller.
 *
 * The caller passes raw fields; the body is markdown with a
 * machine-parseable footer that a downstream observer can scan
 * for the plan id.
 */
export interface PrBodyInputs {
  readonly planId: string;
  readonly planContent: string;
  readonly draftNotes: string;
  readonly draftConfidence: number;
  readonly observationAtomId: string;
  readonly commitSha: string;
  readonly costUsd: number;
  readonly modelUsed: string;
  readonly touchedPaths: ReadonlyArray<string>;
}

const PLAN_CONTENT_CAP = 4000;

export function renderPrBody(inputs: PrBodyInputs): string {
  // Compute the trimmed plan once so the length check and the slice
  // agree. Comparing the untrimmed length against the cap while
  // slicing the trimmed value added false truncation markers when
  // trailing whitespace pushed the raw length over the cap but the
  // body fit.
  const trimmedPlan = inputs.planContent.trim();
  const planTruncated = trimmedPlan.length > PLAN_CONTENT_CAP;
  const planBody = planTruncated ? trimmedPlan.slice(0, PLAN_CONTENT_CAP) : trimmedPlan;

  const lines: string[] = [];
  lines.push('## Summary');
  lines.push('');
  lines.push(inputs.draftNotes || '(no drafter notes provided)');
  lines.push('');
  lines.push('## Plan context');
  lines.push('');
  lines.push(planBody);
  if (planTruncated) lines.push(`\n...(plan truncated at ${PLAN_CONTENT_CAP} chars)...`);
  lines.push('');
  lines.push('## Drafter metadata');
  lines.push('');
  lines.push(`- confidence: ${inputs.draftConfidence.toFixed(2)}`);
  lines.push(`- cost_usd: ${inputs.costUsd.toFixed(4)}`);
  lines.push(`- model: ${inputs.modelUsed}`);
  lines.push(`- touched paths (${inputs.touchedPaths.length}):`);
  for (const p of inputs.touchedPaths) lines.push(`  - \`${p}\``);
  lines.push('');
  lines.push('## Machine-parseable provenance footer');
  lines.push('');
  // JSON.stringify preserves the scalar as a quoted string even if
  // the value contains newlines, colons, or leading/trailing
  // whitespace. A raw interpolation would let a malformed id break
  // YAML parseability for downstream observers that scan the footer
  // for the plan link.
  lines.push('```yaml');
  lines.push(`plan_id: ${JSON.stringify(inputs.planId)}`);
  lines.push(`observation_atom_id: ${JSON.stringify(inputs.observationAtomId)}`);
  lines.push(`commit_sha: ${JSON.stringify(inputs.commitSha)}`);
  lines.push('```');
  return lines.join('\n');
}
