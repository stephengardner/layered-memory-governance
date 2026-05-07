/**
 * buildCanonAtRuntimeStamp: shared helper that builds the canon-at-
 * runtime metadata bag stamped onto persisted stage-output atoms.
 *
 * Why this exists
 * ---------------
 * The deep planning pipeline persists per-stage atoms (brainstorm-output,
 * spec-output, plan, review-report, dispatch-record) whose metadata
 * MUST surface which canon directives bound the LLM at run time. The
 * Console's canon-at-runtime projection reads:
 *
 *   - metadata.canon_directives_applied : ReadonlyArray<AtomId>
 *   - metadata.tool_policy_source       : 'policy' | 'override'
 *   - metadata.tool_policy_principal_id : string  (only when source='policy')
 *
 * Two adapter shapes need to produce the same bag:
 *
 *   1. Single-shot adapters (examples/planning-stages/<stage>/index.ts)
 *      route through host.llm.judge once per stage. They are the
 *      indie-floor default per pol-planning-pipeline-stage-implementations-default
 *      (every stage ships at 'single-shot').
 *
 *   2. Agentic adapters (examples/planning-stages/<stage>/agentic.ts)
 *      route through runStageAgentLoop, which already resolves the
 *      same canon-applicable list + per-principal tool policy and
 *      surfaces the bag as RunStageAgentLoopResult.stageOutputExtraMetadata.
 *
 * Per the dev-duplication-floor canon, two call sites doing the same
 * thing extract a helper at N=2; with five single-shot adapters plus
 * the agent-loop helper, the count is six. This helper is the single
 * point of stamp-construction. runStageAgentLoop calls into this
 * helper too so the two paths cannot drift.
 *
 * Substrate purity
 * ----------------
 * Lives under examples/planning-stages/lib/ alongside the per-stage
 * adapters. The src/ pipeline runner does not see the helper; it only
 * sees `StageOutput.extraMetadata` which the runner shallow-merges
 * into the persisted stage-output atom's metadata.
 *
 * Threat model
 * ------------
 * - The helper takes a PrincipalId (a string) and reads the policy
 *   atom at `pol-llm-tool-policy-<principal>`. Untrusted callers
 *   cannot probe canon for atom-id existence past whatever the
 *   atom store's read surface already exposes; loadLlmToolPolicy
 *   handles unknown principals by returning null.
 * - The canon walker scans clean, non-superseded L3 directives at
 *   project scope; tainted or superseded atoms are filtered out so a
 *   compromised atom cannot widen the resulting list.
 * - Canon ids are trimmed to MAX_CANON_BOUND_LIST so a runaway canon
 *   set cannot blow past the substrate's MAX_CITED_LIST cap when
 *   the runner mints the stage-output atom.
 * - The returned object is frozen so a downstream consumer cannot
 *   mutate the stamp post-hoc; the inner array is also frozen.
 */

import type { Host } from '../../../src/substrate/interface.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
} from '../../../src/substrate/types.js';
// Value import via the package's `imports` map (Node subpath import,
// `#`-prefixed). The relative source-path
// '../../../src/substrate/policy/llm-tool-policy.js' compiles correctly
// via project references but emits the literal string into dist, which
// resolves to a non-existent dist/src/ at runtime (dist/ flattens src/).
// The `#substrate/policy/llm-tool-policy` alias is declared in package.json
// under "imports" with two conditions: "types" routes typecheck to the
// .ts source (no dist required), "default" routes node ESM resolution
// to the built dist artifact. Type-only imports above are erased at
// compile time so their relative src/ prefix is harmless. Mirrors the
// `#runtime/actor-message` pattern in dispatch/index.ts. See
// test/examples/planning-stages/dist-import-paths.test.ts for the
// build-validation gate that catches a regression here.
import { loadLlmToolPolicy } from '#substrate/policy/llm-tool-policy';

/**
 * Maximum canon-bound atom-id list size the helper surfaces. Mirrors
 * the MAX_CITED_LIST cap in src/runtime/planning-pipeline/atom-shapes.ts
 * so a runaway applicable-canon query is trimmed at the helper boundary
 * rather than throwing at the mint site.
 */
export const MAX_CANON_BOUND_LIST = 256;

/**
 * Concrete shape of the canon-at-runtime metadata bag.
 *
 * Shaped as a flat record (extends `Record<string, unknown>`) so callers
 * can spread it onto `StageOutput.extraMetadata` (typed as
 * `Readonly<Record<string, unknown>>`) without an extra cast. The named
 * keys are the load-bearing contract; the index signature is a
 * structural compatibility allowance, not an invitation to pile on
 * extra keys -- additions to this shape go through a typed field plus
 * a corresponding Console projection edit.
 */
export interface CanonAtRuntimeStamp extends Record<string, unknown> {
  readonly canon_directives_applied: ReadonlyArray<string>;
  readonly tool_policy_source: 'policy' | 'override';
  readonly tool_policy_principal_id?: string;
}

export interface BuildCanonAtRuntimeStampOptions {
  /**
   * Records the provenance of the disallowedTools list at the call site:
   *
   *   - 'policy' (default): the caller resolved the per-principal
   *     pol-llm-tool-policy-<principal> atom via loadLlmToolPolicy.
   *     The stamp surfaces tool_policy_principal_id so the Console
   *     projection can resolve the same atom on the read path.
   *   - 'override': the caller supplied a per-call disallowedTools
   *     override and the policy atom was NOT loaded. The stamp omits
   *     tool_policy_principal_id; including it would misattribute
   *     provenance because the canon atom whose id we'd stamp never
   *     bound this run.
   *
   * Single-shot adapters today never take an override; they call the
   * helper with the default. The agentic helper (runStageAgentLoop)
   * passes 'override' when its disallowedToolsOverride input is
   * supplied.
   */
  readonly toolPolicySource?: 'policy' | 'override';
}

/**
 * Resolve the canon directives applicable to the supplied principal at
 * project scope. Reads L3 directive atoms; filters to clean,
 * non-superseded atoms. Mirrors the iteratePolicyAtoms pattern in
 * src/runtime/planning-pipeline/policy.ts so the substrate's canon-
 * applicable read shape stays uniform; the host.canon.applicable seam
 * is reserved for a substrate-wide upgrade and lands in a follow-up.
 *
 * Trims the result at MAX_CANON_BOUND_LIST so the canon-bound event
 * mint helper does not throw on an oversized list. Trim order is
 * scope-rank-then-most-recently-reinforced (a deterministic ordering
 * so a re-run produces the same trimmed set).
 *
 * Per-principal canon filtering is reserved for a follow-up: a future
 * host.canon.applicable seam will accept a PrincipalId and narrow the
 * result to scope-applicable directives. Until that seam lands, this
 * helper returns all clean, non-superseded L3 directives so the call
 * shape can stay stable when the seam adds the principal arg.
 */
export async function resolveApplicableCanon(
  host: Host,
): Promise<{
  readonly atomIds: ReadonlyArray<AtomId>;
  readonly atoms: ReadonlyArray<Atom>;
}> {
  const PAGE_SIZE = 200;
  const MAX_SCAN = 5_000;
  const atoms: Atom[] = [];
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      atoms.push(atom);
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  // Sort by reinforced-time descending so the trim slice keeps the
  // most-recently-reinforced directives. Deterministic on a tie via
  // atom-id string compare.
  atoms.sort((a, b) => {
    if (a.last_reinforced_at !== b.last_reinforced_at) {
      return a.last_reinforced_at < b.last_reinforced_at ? 1 : -1;
    }
    return String(a.id).localeCompare(String(b.id));
  });
  const atomIds = atoms.map((a) => a.id);
  return { atomIds, atoms };
}

/**
 * Pure construction of the canon-at-runtime stamp from already-resolved
 * inputs. Exposed alongside the I/O-bound `buildCanonAtRuntimeStamp` so
 * a caller that has already resolved the canon list (e.g. the agent-
 * loop helper, which resolves the list once for the canon-bound event
 * atom + the LLM prompt) can reuse the resolved set without paying for
 * a second canon query.
 *
 * The freeze + key shape lives here so single-shot and agentic callers
 * cannot drift; both go through this exact construction.
 */
export function buildCanonAtRuntimeStampFromResolved(
  stagePrincipal: PrincipalId,
  canonAtomIds: ReadonlyArray<AtomId>,
  toolPolicySource: 'policy' | 'override',
): CanonAtRuntimeStamp {
  const trimmed = canonAtomIds.slice(0, MAX_CANON_BOUND_LIST);
  return Object.freeze({
    canon_directives_applied: Object.freeze(trimmed.map(String)),
    tool_policy_source: toolPolicySource,
    ...(toolPolicySource === 'policy'
      ? { tool_policy_principal_id: String(stagePrincipal) }
      : {}),
  }) as CanonAtRuntimeStamp;
}

/**
 * Build the canon-at-runtime metadata bag the caller forwards into
 * StageOutput.extraMetadata.
 *
 * The bag is the source-of-truth answer to the Console projection's
 * question 'which canon directives ACTUALLY bound the LLM for this
 * stage atom'. The single-shot caller side-effects nothing more than
 * a canon read + policy-atom read; the agentic caller has already
 * done the same reads inside runStageAgentLoop and uses
 * buildCanonAtRuntimeStampFromResolved to avoid duplicating the work.
 *
 * Frozen so a downstream consumer cannot mutate the stamp post-hoc;
 * strings are immutable so the inner principal id needs no separate
 * freeze. Defensive copy on the canon id list mirrors the freeze
 * pattern in run-stage-agent-loop.ts.
 */
export async function buildCanonAtRuntimeStamp(
  host: Host,
  stagePrincipal: PrincipalId,
  options?: BuildCanonAtRuntimeStampOptions,
): Promise<CanonAtRuntimeStamp> {
  const toolPolicySource: 'policy' | 'override' =
    options?.toolPolicySource ?? 'policy';

  // Load the per-principal policy atom only when the stamp records a
  // policy-source provenance; an override-bound run did not consult
  // the atom and the stamp must not lie about the provenance chain.
  //
  // The return value is intentionally discarded. The stamp answers the
  // Console projection's question "which canon atom would have bound
  // the LLM under policy-source"; the answer is the canonical
  // pol-llm-tool-policy-<principal> atom keyed by principal id. The
  // Console reads tool_policy_principal_id and re-resolves that atom
  // on the read path, so a null return here (missing/tainted/superseded
  // atom) is correctly rendered downstream as "policy atom not present"
  // rather than misattributed as an override-bound run.
  //
  // The load is still issued for two side-effects:
  //   1. A malformed payload throws LlmToolPolicyError, which bubbles
  //      out and surfaces to the runner's catastrophic-failure handler
  //      (per inv-governance-before-autonomy: a malformed canon edit
  //      must fail loud, not silently widen tool access).
  //   2. The atom-store hit warms the cache for any concurrent reader
  //      (e.g. the Console) that polls the same atom id after the
  //      stage atom lands.
  //
  // Mirrors the runStageAgentLoop pattern at run-stage-agent-loop.ts
  // where policy?.disallowedTools is consumed and the load is also
  // unconditional under policy-source.
  if (toolPolicySource === 'policy') {
    await loadLlmToolPolicy(host.atoms, stagePrincipal);
  }

  const { atomIds: canonAtomIdsAll } = await resolveApplicableCanon(host);
  return buildCanonAtRuntimeStampFromResolved(
    stagePrincipal,
    canonAtomIdsAll,
    toolPolicySource,
  );
}
