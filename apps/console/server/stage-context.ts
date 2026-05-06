/**
 * Stage Context: surface the operator-visible "soul" + upstream chain
 * + canon-at-runtime that produced a pipeline-stage atom.
 *
 * The endpoint at /api/atoms.stage-context wraps this module. Each
 * stage agent in the deep planning pipeline runs under (a) a vendored
 * `superpowers` skill bundle that supplies the prompt soul, (b) a
 * derived_from chain pointing back to the seed operator-intent, and
 * (c) the per-principal LLM tool-policy atoms that bound its tool
 * surface. The Console's plan-detail + deliberation views need all
 * three to answer "how was this stage prompted?" without round-tripping
 * to the disk -- this module returns the projection.
 *
 * Substrate purity:
 *   - Stage -> principal + skill-bundle mapping reuses
 *     `examples/planning-stages/lib/stage-mapping.ts` so the source of
 *     truth is the same table the adapters consume.
 *   - Soul markdown read goes through `resolveSkillBundle` (plugin-cache
 *     priority + vendored fallback), not a direct fs.readFile against
 *     a hardcoded path.
 *   - The upstream-chain walk delegates to a caller-supplied function
 *     so this module stays an inert projection -- the caller (server
 *     handler) is responsible for the AtomStore lookup.
 *   - Canon-at-runtime resolution defers to a caller-supplied function
 *     too; v1 ships the policy-atom fallback, v2 reads
 *     `metadata.canon_directives_applied` when the substrate emits it.
 *
 * The module is pure-data-in, pure-data-out; it has no fs/net side
 * effects of its own beyond the call-through to `resolveSkillBundle`.
 */

import {
  bindingForStage,
  stageForAtom,
  type PipelineStageName,
} from '../../../examples/planning-stages/lib/stage-mapping.js';
import {
  resolveSkillBundle,
  SkillBundleNotFoundError,
} from '../../../examples/planning-stages/lib/skill-bundle-resolver.js';

/** Minimal atom shape the projection needs. */
export interface StageContextAtom {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly created_at?: string;
  /**
   * The principal_id the substrate persisted on the atom. Pipeline-
   * emitted stage-output atoms carry the pipeline-runner principal id
   * (e.g. `cto-actor`), which may differ from the stage-mapping table's
   * declared principal (e.g. `plan-author` for plan-stage). The
   * canon-at-runtime projection unions this with the stage-mapping
   * principal when resolving per-principal LLM tool-policy atoms so the
   * panel surfaces the canon that ACTUALLY bound the LLM, not the
   * canon the table CLAIMS bound it.
   */
  readonly principal_id?: string;
}

export interface StageContextChainEntry {
  readonly id: string;
  readonly type: string;
  /** First ~240 chars of the atom's content, newline-collapsed. */
  readonly content_preview: string;
}

export interface StageContextCanonEntry {
  readonly id: string;
  readonly type: string;
  /** First ~240 chars of the canon atom's content, newline-collapsed. */
  readonly content_preview: string;
  /** Source of the directive: 'metadata' (recorded at run-time) or 'policy' (resolved as fallback). */
  readonly source: 'metadata' | 'policy';
}

export interface StageContextResponse {
  /** Canonical stage name, or null when the atom is not a pipeline-stage output. */
  readonly stage: PipelineStageName | null;
  /** The agent principal that ran the stage, or null when stage is null. */
  readonly principal_id: string | null;
  /** The vendored skill-bundle name supplied to the agent, or null when stage is null. */
  readonly skill_bundle: string | null;
  /** The full markdown content of the soul prompt, or null when stage is null or the bundle is missing. */
  readonly soul: string | null;
  /** Earliest -> latest provenance ancestors of the atom (deduped). */
  readonly upstream_chain: ReadonlyArray<StageContextChainEntry>;
  /** Canon directives that governed this stage at run-time. */
  readonly canon_at_runtime: ReadonlyArray<StageContextCanonEntry>;
}

/** Maximum chain depth to walk; chosen to fit a full pipeline + intent. */
export const STAGE_CONTEXT_MAX_DEPTH = 8;
const PREVIEW_MAX_CHARS = 240;

/**
 * Empty stage-context response. Used when the atom is not a pipeline
 * stage output. Returning a stable shape (rather than `null`) keeps
 * the client renderer simple: it always renders the panel header,
 * empty-states each tab independently when the corresponding field
 * is empty.
 */
export const EMPTY_STAGE_CONTEXT: StageContextResponse = Object.freeze({
  stage: null,
  principal_id: null,
  skill_bundle: null,
  soul: null,
  upstream_chain: Object.freeze([]),
  canon_at_runtime: Object.freeze([]),
});

/**
 * Collapse whitespace and clip to PREVIEW_MAX_CHARS. Plain string trim
 * + ellipsis; not a markdown render.
 */
export function previewContent(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, PREVIEW_MAX_CHARS - 1)}\u2026`;
}

/**
 * Walk upstream provenance.derived_from from the seed atom in BFS
 * order, deduped. Returns earliest-created -> latest-created (i.e.
 * the seed operator-intent first, the immediate parent stage last).
 *
 * Cycle-safe via a visited set; depth-limited to avoid runaway walks
 * if metadata wires a self-loop.
 *
 * The atomLookup function returns the atom for a given id, or null
 * when the id is unknown. Unknown ids are silently skipped (atoms
 * may have been pruned or the chain may reference a fixture id) so
 * the chain renders best-effort.
 */
export function buildUpstreamChain(
  seed: StageContextAtom,
  atomLookup: (id: string) => StageContextAtom | null,
  options: { readonly maxDepth?: number } = {},
): ReadonlyArray<StageContextChainEntry> {
  const maxDepth = options.maxDepth ?? STAGE_CONTEXT_MAX_DEPTH;
  const visited = new Set<string>([seed.id]);
  const collected: StageContextAtom[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: seed.id, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    if (next.depth > maxDepth) continue;
    const atom = next.id === seed.id ? seed : atomLookup(next.id);
    if (!atom) continue;
    if (next.id !== seed.id) collected.push(atom);
    const derived = readDerivedFrom(atom);
    for (const ancestor of derived) {
      if (visited.has(ancestor)) continue;
      visited.add(ancestor);
      queue.push({ id: ancestor, depth: next.depth + 1 });
    }
  }
  // Sort earliest -> latest by created_at; atoms without a timestamp
  // sort before timestamped atoms so a synthetic root with no ts still
  // appears at the head of the chain rather than getting dropped.
  collected.sort((a, b) => {
    const aTs = a.created_at ?? '';
    const bTs = b.created_at ?? '';
    return aTs.localeCompare(bTs);
  });
  return collected.map<StageContextChainEntry>((atom) => ({
    id: atom.id,
    type: atom.type,
    content_preview: previewContent(atom.content),
  }));
}

function readDerivedFrom(atom: StageContextAtom): ReadonlyArray<string> {
  const provenance = atom.provenance;
  if (!provenance || typeof provenance !== 'object') return [];
  const raw = (provenance as { derived_from?: unknown }).derived_from;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string =>
    typeof value === 'string' && value.length > 0,
  );
}

/**
 * Build the canon-at-runtime list. Source-precedence:
 *
 *   1. metadata.canon_directives_applied  (strongest: write-time list)
 *      When present, those ids are authoritative. The fallback paths
 *      are NOT consulted, even when every id fails to resolve -- a
 *      stamped-but-pruned id means 'the runner stamped X here at
 *      write time', and silently falling through to inference would
 *      lie to the operator about which directives governed the run.
 *
 *   2. metadata.tool_policy_principal_id  (write-time evidence)
 *      When present, the substrate stamped exactly which principal's
 *      pol-llm-tool-policy-<P> atom was loaded for this run (set by
 *      runStageAgentLoop only when toolPolicySource='policy', i.e. the
 *      canonical atom WAS loaded; never stamped on override-bound
 *      runs, see run-stage-agent-loop.ts). This is strictly stronger
 *      evidence than inferring from atom.principal_id or from the
 *      stage-mapping table because it records what the runner actually
 *      consulted. Resolve that one policy atom and surface it with
 *      source='metadata' (the read came from stamped metadata, even
 *      though the atom is a pol-* shape).
 *
 *   3. Dual-principal inference  (weakest: read-time guess)
 *      Resolve `pol-llm-tool-policy-<P>` for every P in the union of
 *      (a) the stage-mapping principal and (b) the atom's
 *      principal_id when present, deduped. Operator value pin: 'a
 *      plan atom showing the canon that ACTUALLY bound the LLM, not
 *      the canon the table CLAIMS bound it'. The atom's principal_id
 *      is the truer signal because the substrate persisted it; the
 *      stage-mapping principal stays in the union as a backstop for
 *      atoms without a principal_id (tests, fixtures, single-shot
 *      adapters).
 *
 * Unknown atom ids resolve to `null` via atomLookup and are silently
 * skipped; the policy atom for a never-bound principal does not exist
 * on disk.
 *
 * `atomPrincipalId` is optional so legacy callers (tests that build
 * the request without an atom shape) continue to work unchanged; when
 * omitted only the stage-mapping principal seeds the inference.
 */
export function buildCanonAtRuntime(
  stageMetadata: Readonly<Record<string, unknown>> | undefined,
  principalId: string,
  atomLookup: (id: string) => StageContextAtom | null,
  atomPrincipalId?: string,
): ReadonlyArray<StageContextCanonEntry> {
  const explicitIds = readCanonDirectivesApplied(stageMetadata);
  if (explicitIds.length > 0) {
    return projectCanonEntries(explicitIds, atomLookup, 'metadata');
  }
  // Tier 2: stamped tool_policy_principal_id. The substrate writes this
  // ONLY when the canonical pol-llm-tool-policy-<P> atom was loaded
  // (run-stage-agent-loop.ts toolPolicySource='policy'); the Console
  // can therefore trust it as write-time evidence and skip the
  // dual-principal inference. Source label is 'metadata' because the
  // selection signal came from stamped metadata even though the
  // resolved atom is a pol-* directive.
  const stampedPrincipal = readToolPolicyPrincipalId(stageMetadata);
  if (stampedPrincipal !== null) {
    return projectCanonEntries(
      [`pol-llm-tool-policy-${stampedPrincipal}`],
      atomLookup,
      'metadata',
    );
  }
  // Tier 3: union of stage-mapping principal + atom's own principal_id
  // (when present), deduped by policy-atom id. Empty / whitespace-only
  // ids are filtered before composing the policy id so a malformed
  // upstream cannot surface `pol-llm-tool-policy-` (a real but mostly-
  // empty atom id that would resolve to nothing). The atom's
  // principal_id is the truer signal because the substrate persisted
  // it; the stage-mapping principal stays in the union as a backstop
  // for atoms that lack a principal_id.
  const principalIds: string[] = [];
  const seenPrincipals = new Set<string>();
  for (const candidate of [principalId, atomPrincipalId]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (seenPrincipals.has(trimmed)) continue;
    seenPrincipals.add(trimmed);
    principalIds.push(trimmed);
  }
  const policyIds = principalIds.map((p) => `pol-llm-tool-policy-${p}`);
  return projectCanonEntries(policyIds, atomLookup, 'policy');
}

/**
 * Read metadata.tool_policy_principal_id with the same defensive
 * trimming the dual-principal inference path applies. Returns null
 * when the field is absent, non-string, or whitespace-only so the
 * caller falls through to the inference path rather than composing
 * `pol-llm-tool-policy-` (the empty-suffix atom id) and surfacing a
 * never-resolving lookup as 'metadata-bound'.
 */
function readToolPolicyPrincipalId(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | null {
  if (!metadata) return null;
  const raw = metadata['tool_policy_principal_id'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function readCanonDirectivesApplied(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ReadonlyArray<string> {
  if (!metadata) return [];
  const raw = metadata['canon_directives_applied'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string =>
    typeof value === 'string' && value.length > 0,
  );
}

function projectCanonEntries(
  ids: ReadonlyArray<string>,
  atomLookup: (id: string) => StageContextAtom | null,
  source: 'metadata' | 'policy',
): ReadonlyArray<StageContextCanonEntry> {
  const out: StageContextCanonEntry[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const atom = atomLookup(id);
    if (!atom) continue;
    out.push({
      id: atom.id,
      type: atom.type,
      content_preview: previewContent(atom.content),
      source,
    });
  }
  return out;
}

export interface BuildStageContextOptions {
  /**
   * Override the skill-bundle resolver -- useful for tests so the
   * fixture can fix the soul markdown without standing up the
   * filesystem.
   */
  readonly resolveBundle?: (skillName: string) => Promise<string | null>;
  /** Test-only: cap upstream-chain walk depth. */
  readonly maxDepth?: number;
}

/**
 * Top-level build: combines the stage-derivation, soul resolution,
 * upstream-chain walk, and canon-at-runtime resolution into the
 * single response shape the endpoint returns.
 *
 * Returns EMPTY_STAGE_CONTEXT when the atom is not a pipeline-stage
 * output. Soul resolution fail-soft returns `null` so a missing
 * vendored bundle does not 500 the endpoint -- the operator sees the
 * upstream chain even when the soul is absent.
 */
export async function buildStageContext(
  atom: StageContextAtom,
  atomLookup: (id: string) => StageContextAtom | null,
  options: BuildStageContextOptions = {},
): Promise<StageContextResponse> {
  const stage = stageForAtom(atom.type, atom.metadata);
  if (stage === null) return EMPTY_STAGE_CONTEXT;
  const binding = bindingForStage(stage);
  if (binding === null) return EMPTY_STAGE_CONTEXT;

  const soul = await resolveSoulSafely(binding.skillBundle, options.resolveBundle);

  const upstreamOpts = options.maxDepth !== undefined
    ? { maxDepth: options.maxDepth }
    : {};
  const upstreamChain = buildUpstreamChain(atom, atomLookup, upstreamOpts);
  // Forward the atom's persisted principal_id alongside the stage-mapping
  // principal so the canon-at-runtime fallback union surfaces both
  // policies. The stage-mapping principal is the table's claim; the
  // atom's principal_id is what the substrate actually persisted, and
  // for pipeline-emitted stage-output atoms the two diverge (the runner
  // stamps `cto-actor` while the table claims `plan-author`). Operator
  // value pin: the panel must show the canon that ACTUALLY bound the
  // LLM.
  const canonAtRuntime = buildCanonAtRuntime(
    atom.metadata,
    binding.principalId,
    atomLookup,
    atom.principal_id,
  );

  return {
    stage,
    principal_id: binding.principalId,
    skill_bundle: binding.skillBundle,
    soul,
    upstream_chain: upstreamChain,
    canon_at_runtime: canonAtRuntime,
  };
}

async function resolveSoulSafely(
  skillBundle: string,
  override: BuildStageContextOptions['resolveBundle'],
): Promise<string | null> {
  if (override) {
    try {
      return await override(skillBundle);
    } catch {
      return null;
    }
  }
  try {
    return await resolveSkillBundle(skillBundle);
  } catch (err) {
    /*
     * `SkillBundleNotFoundError` is the expected case when the agent
     * worktree has no plugin cache AND the vendored copy was renamed.
     * Surface as null rather than 500 so the rest of the panel
     * still renders. Any other error is unexpected; same fall-soft.
     */
    if (err instanceof SkillBundleNotFoundError) {
      return null;
    }
    return null;
  }
}
