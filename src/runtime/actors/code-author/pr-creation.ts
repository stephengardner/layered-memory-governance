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
import type { Atom } from '../../../types.js';
import type { Host } from '../../../interface.js';

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
  /**
   * Optional per-atom JSON snapshots emitted as collapsible
   * `<details>` blocks at the end of the body. Each entry's `id`
   * is rendered in the section anchor and is the round-trip
   * integrity guard a downstream consumer can validate before
   * trusting the embedded payload (the parsed JSON's `id` field
   * must equal the lookup id).
   *
   * The body becomes a carrier for governance state a downstream
   * observer can parse without reaching back to the producing
   * host's atom store. Optional so callers that do not need a
   * carrier keep their current body shape; callers that need
   * one populate this with whatever atoms the consumer expects.
   */
  readonly embeddedAtoms?: ReadonlyArray<EmbeddedAtomSnapshot>;
}

export interface EmbeddedAtomSnapshot {
  readonly id: string;
  /**
   * The atom payload JSON-stringified by the caller. Pre-stringified
   * (rather than `unknown`) so callers control encoding (pretty-print,
   * key sorting) and the consumer-side parse is symmetric.
   */
  readonly json: string;
}

const PLAN_CONTENT_CAP = 4000;
/**
 * Cap on each embedded atom JSON so a pathological atom cannot
 * blow past GitHub's PR body length limit (65536 chars for the
 * description field on the REST API). The 16kB per-atom ceiling
 * leaves room for several snapshots before the body limit
 * becomes a concern. Truncation rather than fail-closed because
 * the truncation marker deliberately produces unparseable JSON,
 * which makes the parser surface a clear "malformed JSON"
 * diagnostic rather than silently using a half-cropped atom.
 */
const EMBEDDED_ATOM_JSON_CAP = 16_384;
/**
 * Section heading for the embedded-atoms block. Stable string the
 * consumer-side parser anchors to; changing this value is a wire-
 * compatibility break that requires a coordinated parser update
 * AND a deployment that processes both the old + new shape during
 * the rollout window.
 */
export const EMBEDDED_ATOMS_HEADING = '## Embedded atom snapshots';

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
  // Embedded-atom block: rendered last so the carrier is at the
  // body tail where downstream parsers anchor. Each snapshot
  // lives inside a collapsible <details> with the atom id on the
  // summary line so a consumer can scope its parse to a specific
  // atom. Skipped entirely when no snapshots are passed; existing
  // callers keep their current body shape because the section is
  // purely opt-in.
  const snapshots = inputs.embeddedAtoms ?? [];
  if (snapshots.length > 0) {
    lines.push('');
    lines.push(EMBEDDED_ATOMS_HEADING);
    lines.push('');
    for (const snap of snapshots) {
      lines.push(renderEmbeddedAtomBlock(snap));
    }
  }
  return lines.join('\n');
}

/**
 * Render one embedded-atom block. Pure, exported for tests; the
 * production caller path runs through renderPrBody.
 *
 * Shape (single block):
 *   <details><summary>atom: &lt;id&gt;</summary>
 *
 *   ```json
 *   {...}
 *   ```
 *
 *   </details>
 *
 * The atom id appears HTML-escaped in the summary so an id with
 * literal `<`, `>`, or `&` does not break the surrounding HTML
 * parse on GitHub's renderer. The id used by the consumer-side
 * parser is the JSON payload's own `id` field (not the summary
 * text), so the summary's HTML-escape is a rendering concern
 * separate from the parser's integrity contract.
 */
export function renderEmbeddedAtomBlock(snap: EmbeddedAtomSnapshot): string {
  const safeJson = capEmbeddedJson(snap.json);
  // HTML-escape the id for the rendered <summary>; the parser
  // recovers the canonical id from the JSON payload, so this is a
  // display concern only.
  const escapedSummaryId = snap.id
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return [
    `<details><summary>atom: ${escapedSummaryId}</summary>`,
    '',
    '```json',
    safeJson,
    '```',
    '',
    '</details>',
  ].join('\n');
}

/**
 * Build a snapshot pair {plan, ancestor} suitable for the
 * `embeddedAtoms` field on renderPrBody: walks
 * `plan.provenance.derived_from` looking for an atom of
 * `ancestorType`; when found, returns both serialized.
 *
 * Returns an empty array when no provenance ancestor of the
 * requested type is reachable. Callers consume the empty list
 * by skipping the embedded-atoms section entirely (renderPrBody
 * does this automatically), keeping the body shape clean for
 * plans that do not need a carrier.
 *
 * Centralized here so multiple executors that emit the same
 * snapshot pair share one chain-walk rather than duplicating it.
 */
export async function buildEmbeddedAtomSnapshots(
  host: Host,
  plan: Atom,
  ancestorType: string = 'operator-intent',
): Promise<ReadonlyArray<EmbeddedAtomSnapshot>> {
  const derivedFrom = plan.provenance?.derived_from ?? [];
  for (const refId of derivedFrom) {
    const candidate = await host.atoms.get(refId);
    if (candidate?.type === ancestorType) {
      // Plan first so a downstream consumer's primary lookup
      // hits a snapshot before walking provenance; ancestor
      // second so the rendered body reads top-down (plan ->
      // its provenance). Order is not load-bearing for the
      // parser (which scans every block by id) but improves
      // readability for human reviewers.
      return [
        { id: String(plan.id), json: serializeAtom(plan) },
        { id: String(candidate.id), json: serializeAtom(candidate) },
      ];
    }
  }
  return [];
}

/**
 * Stable, sorted-key JSON serialization for atom snapshots. Sorted
 * keys keep the output deterministic so two PRs that ship the
 * same atom produce identical `<details>` blocks; identical body
 * blocks make the round-trip integrity check (the parser
 * comparing the embedded `id` to the lookup id) trivially
 * symmetric on the wire.
 *
 * 2-space indent matches GitHub's default Markdown JSON-block
 * rendering for readability.
 */
function serializeAtom(atom: Atom): string {
  return JSON.stringify(atom, sortedKeysReplacer, 2);
}

function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

function capEmbeddedJson(raw: string): string {
  if (raw.length <= EMBEDDED_ATOM_JSON_CAP) return raw;
  // Append an unparseable trailer so the parser fails loudly
  // rather than silently using a half-cropped atom. The
  // consumer's not-found fallback path then surfaces the
  // underlying issue.
  return `${raw.slice(0, EMBEDDED_ATOM_JSON_CAP)}\n/* truncated at ${EMBEDDED_ATOM_JSON_CAP} chars */`;
}
