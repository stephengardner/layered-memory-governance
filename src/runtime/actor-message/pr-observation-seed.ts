/**
 * pr-observation seed builder for the code-author dispatch path.
 *
 * Closes the substrate gap (gap #8 part 2) where a code-author dispatch
 * that opens a PR produces ONE observation atom of kind
 * `code-author-invoked` and zero atoms of kind `pr-observation`. The
 * runPlanObservationRefreshTick pass filters strictly on
 * `metadata.kind === 'pr-observation'`, so a code-author-invoked atom
 * is invisible to it; the PR-merge-reconcile pass (which closes the
 * Plan -> succeeded loop on terminal pr_state) then never fires for
 * the PR.
 *
 * The fix is to write a SECOND atom on dispatch: a synthesized
 * pr-observation seed that carries the canonical metadata shape the
 * refresh tick expects. The seed is a `partial: true` placeholder
 * (we have no fresh GitHub query at dispatch time, so we cannot fill
 * in submitted reviews, check-runs, etc.); on its first refresh-tick
 * pass after the freshness window expires, the deployment-side
 * refresher will replace it with a hydrated observation.
 *
 * Why a SEPARATE atom (not metadata-overload on code-author-invoked)
 * -----------------------------------------------------------------
 * pr-observation-refresh's filter `meta.kind === 'pr-observation'` is
 * mechanism that other consumers (pr-merge-reconcile, console
 * projections, future plan-observation viewers) also key on. Making
 * code-author-invoked dual-purpose would couple both paths and force
 * every downstream reader to branch on whichever discriminator was
 * observed first. The two atoms have distinct semantic meanings
 * (`code-author-invoked` = "dispatch fired, fence loaded, executor
 * returned X"; `pr-observation` = "PR currently in state Y at
 * observed_at Z") and provenance chains both back to the same plan,
 * so the audit trace stays clean.
 *
 * Substrate purity: no GitHub I/O. The helper takes a structured
 * `CodeAuthorExecutorSuccess` plus the plan id and produces the atom
 * shape; the caller writes it via `host.atoms.put`.
 */

import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../types.js';
import { mkPrObservationAtomId } from '../actors/pr-landing/pr-observation.js';
import type { CodeAuthorExecutorSuccess } from './code-author-invoker.js';

/**
 * Parsed (owner, repo, number) tuple read from a PR HTML URL of shape
 * `https://github.com/<owner>/<repo>/pull/<number>`. The substrate is
 * agnostic to non-github.com hosts; the exporter pins the github.com
 * shape because the rest of the LAG repo's bot identities, status
 * checks, and review tooling target it. A future GitLab adapter
 * would write a parallel helper rather than overloading this one
 * (same discipline as pr-observation.ts).
 */
export interface ParsedPrUrl {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * Parse a `https://github.com/<owner>/<repo>/pull/<number>` URL.
 *
 * Throws a descriptive Error on:
 *   - non-string input
 *   - unparseable URL (no scheme, malformed path)
 *   - host that is not github.com (subdomain or different host)
 *   - missing `/pull/` segment
 *   - non-integer or non-positive PR number
 *
 * Fail-loud is the correct posture per inv-governance-before-autonomy:
 * a malformed URL means the upstream caller (drafter, executor, gh
 * REST shim) produced inconsistent state; silently writing a malformed
 * atom would propagate the corruption. The invoker catches the throw
 * via the existing executor try/catch and records an executor-threw
 * stage on the code-author-invoked observation.
 */
export function parsePrHtmlUrl(prHtmlUrl: string): ParsedPrUrl {
  if (typeof prHtmlUrl !== 'string' || prHtmlUrl.length === 0) {
    throw new Error(`pr-observation-seed: prHtmlUrl must be a non-empty string, got ${typeof prHtmlUrl}`);
  }
  let url: URL;
  try {
    url = new URL(prHtmlUrl);
  } catch (err) {
    throw new Error(
      `pr-observation-seed: prHtmlUrl is not a valid URL: ${prHtmlUrl} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `pr-observation-seed: prHtmlUrl must use http(s) scheme, got ${url.protocol} in ${prHtmlUrl}`,
    );
  }
  // Pin to github.com (no subdomains, no GHES). A future host adapter
  // exports its own helper; we never silently accept a non-canonical
  // host, because downstream tooling (gh CLI, branch protection,
  // status checks) all assume the canonical host.
  if (url.hostname !== 'github.com') {
    throw new Error(
      `pr-observation-seed: prHtmlUrl host must be github.com, got ${url.hostname} in ${prHtmlUrl}`,
    );
  }
  // Path shape: `/<owner>/<repo>/pull/<number>` (with optional trailing
  // `/`). `URL.pathname` always begins with `/`; split and discard the
  // leading empty segment.
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 4) {
    throw new Error(
      `pr-observation-seed: prHtmlUrl pathname has too few segments (need /<owner>/<repo>/pull/<number>): ${prHtmlUrl}`,
    );
  }
  const [owner, repo, segment, numberRaw] = segments;
  if (segment !== 'pull') {
    throw new Error(
      `pr-observation-seed: prHtmlUrl path segment 3 must be 'pull', got '${segment ?? ''}' in ${prHtmlUrl}`,
    );
  }
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error(`pr-observation-seed: prHtmlUrl owner segment is empty: ${prHtmlUrl}`);
  }
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error(`pr-observation-seed: prHtmlUrl repo segment is empty: ${prHtmlUrl}`);
  }
  if (typeof numberRaw !== 'string' || numberRaw.length === 0) {
    throw new Error(`pr-observation-seed: prHtmlUrl number segment is empty: ${prHtmlUrl}`);
  }
  const number = Number(numberRaw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      `pr-observation-seed: prHtmlUrl number segment is not a positive integer: '${numberRaw}' in ${prHtmlUrl}`,
    );
  }
  return { owner, repo, number };
}

export interface PrObservationSeedInputs {
  readonly principal: PrincipalId;
  readonly planId: string;
  readonly executorResult: CodeAuthorExecutorSuccess;
  readonly observedAt: Time;
  readonly correlationId?: string;
}

/**
 * Build the synthesized pr-observation seed atom for a successful
 * code-author dispatch.
 *
 * Confidence is 0.7 because we did NOT query GitHub for the live PR
 * state; we synthesized the seed from the executor's return value.
 * `metadata.partial = true` and `partial_surfaces = ['all']` flag the
 * synthesized state explicitly so a downstream consumer that conditions
 * on `partial !== true` (a renderer that only wants hydrated
 * observations) skips the seed cleanly.
 *
 * The atom id reuses `mkPrObservationAtomId` from the pr-landing
 * builder so two paths writing for the same PR + head SHA + minute
 * collapse to the same id (idempotent). A pr-landing observe-only run
 * minutes later that produces a hydrated observation under the same
 * id supersedes this seed via the standard atom-store put semantics.
 */
export function mkPrObservationSeedAtom(inputs: PrObservationSeedInputs): Atom {
  const { principal, planId, executorResult, observedAt, correlationId } = inputs;
  const { owner, repo, number } = parsePrHtmlUrl(executorResult.prHtmlUrl);
  const headSha = executorResult.commitSha;
  if (typeof headSha !== 'string' || headSha.length === 0) {
    throw new Error(
      `pr-observation-seed: executorResult.commitSha must be a non-empty string, got ${typeof headSha}`,
    );
  }
  const atomId = mkPrObservationAtomId(owner, repo, number, headSha, observedAt);
  return {
    schema_version: 1,
    id: atomId,
    content: renderSeedContent({ owner, repo, number, headSha, observedAt, planId }),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: String(principal),
        tool: 'code-author-invoker-pr-observation-seed',
        ...(correlationId !== undefined ? { session_id: correlationId } : {}),
      },
      // Chain to the plan that produced the dispatch so an audit
      // walk from `succeeded` plan -> dispatch -> observation reads
      // cleanly. The plan id is the only derivation source: there is
      // no prior pr-observation atom for this PR (this seed IS the
      // first), so we do not push a priorId.
      derived_from: [planId as AtomId],
    },
    confidence: 0.7,
    created_at: observedAt,
    last_reinforced_at: observedAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: principal,
    taint: 'clean',
    metadata: {
      kind: 'pr-observation',
      pr: { owner, repo, number },
      head_sha: headSha,
      observed_at: observedAt,
      pr_state: 'OPEN',
      plan_id: planId,
      // Synthesized seed: we did NOT query GitHub. partial=true tells
      // any consumer that conditions on "fully hydrated" to skip,
      // and partial_surfaces=['all'] is the maximally-conservative
      // value (every surface is missing). The refresh tick will
      // replace this with a hydrated observation on its first pass
      // after the freshness window expires.
      partial: true,
      partial_surfaces: ['all'],
      // Empty counts so a consumer reading metadata.counts does not
      // need a defensive null check; the partial flag is the gate
      // for "trust these counts" semantics.
      counts: {
        line_comments: 0,
        body_nits: 0,
        submitted_reviews: 0,
        check_runs: 0,
        legacy_statuses: 0,
      },
      // No live GitHub query => no mergeability or merge-state info.
      // Explicit nulls match the `mkPrObservationAtom` shape so
      // downstream consumers can branch on null without a defensive
      // typeof check for the field's presence.
      mergeable: null,
      merge_state_status: null,
      // Intentionally NO `pr_title`: per the canonical builder's
      // omit-when-null comment, materializing a null pr_title would
      // force consumers to add a defensive type guard for a value
      // they would never use.
    },
  };
}

function renderSeedContent(args: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly observedAt: Time;
  readonly planId: string;
}): string {
  const { owner, repo, number, headSha, observedAt, planId } = args;
  const lines: string[] = [];
  lines.push(`**pr-observation seed for ${owner}/${repo}#${number}** (synthesized at code-author dispatch)`);
  lines.push('');
  lines.push(`observed_at: ${observedAt}`);
  lines.push(`head_sha: \`${headSha}\``);
  lines.push('pr_state: OPEN');
  lines.push(`plan_id: ${planId}`);
  lines.push('partial: true (synthesized seed; refresh tick will hydrate)');
  lines.push('');
  lines.push('_Emitted by code-author-invoker when executor_result.kind=\'dispatched\'.');
  lines.push('The pr-observation-refresh tick will replace this seed with a fresh');
  lines.push('observation on its next pass once the freshness window expires._');
  return lines.join('\n');
}
