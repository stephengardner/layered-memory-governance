/**
 * Claim extraction: L0 raw -> L1 structured claims.
 *
 * Each L0 atom (typically a transcript line from an ingester) is fed
 * through the LLM judge with the EXTRACT_CLAIMS schema. The judge
 * returns up to 10 discrete claims with type, content, and confidence.
 * Each claim becomes a new L1 atom with:
 *   - `provenance.kind = 'llm-refined'`
 *   - `provenance.derived_from = [sourceAtomId]` (preserves lineage)
 *   - `principal_id` inherited from the source (agent that wrote the L0)
 *   - content-hash dedup: if two L0 atoms produce the same claim text,
 *     the L1 atoms collide and `put()` throws ConflictError, which we
 *     swallow. Consensus emerges naturally.
 *
 * The extraction module is a governance primitive in the same family
 * as decay, promotion, and taint cascade. It transforms one layer into
 * the next with provenance preserved.
 */

import { ConflictError } from '../substrate/errors.js';
import type { Host } from '../substrate/interface.js';
import {
  EXTRACT_CLAIMS,
  type ExtractClaimsOutput,
} from '../schemas/index.js';
import type {
  Atom,
  AtomFilter,
  AtomId,
  AtomType,
  LlmOptions,
  PrincipalId,
  Time,
} from '../substrate/types.js';

export interface ExtractClaimsOptions {
  /** Principal attributed to the extraction operation itself (for audit). */
  readonly principalId: PrincipalId;
  /** LLM judge tuning. Defaults: Haiku, 0.50 USD budget, 60s timeout. */
  readonly llm?: Partial<LlmOptions>;
  /**
   * If true, the extracted L1 atoms are attributed to the SOURCE atom's
   * principal (the agent that wrote the L0). If false, attributed to
   * `options.principalId` (the extractor's principal). Default: true.
   * The first is correct for the autonomous-org story; the second is
   * useful for an extraction-only agent with its own identity.
   */
  readonly inheritSourcePrincipal?: boolean;
  /** Minimum claim confidence to keep. Below this, the claim is dropped. Default 0.3. */
  readonly minConfidence?: number;
}

export interface ExtractionReport {
  readonly sourceAtomId: AtomId;
  readonly claimsFound: number;
  readonly atomsWritten: number;
  readonly atomsDeduped: number;
  readonly atomsBelowThreshold: number;
  readonly errors: ReadonlyArray<string>;
  readonly writtenAtomIds: ReadonlyArray<AtomId>;
}

const DEFAULT_LLM_OPTIONS: LlmOptions = Object.freeze({
  model: 'claude-haiku-4-5-20251001',
  max_budget_usd: 0.5,
  timeout_ms: 60_000,
});

/**
 * Extract claims from a single L0 atom and write them as L1 atoms.
 * Idempotent across runs (content-hash dedup at the AtomStore layer
 * prevents duplicate writes).
 */
export async function extractClaimsFromAtom(
  sourceAtom: Atom,
  host: Host,
  options: ExtractClaimsOptions,
): Promise<ExtractionReport> {
  if (sourceAtom.layer !== 'L0') {
    throw new Error(
      `extractClaimsFromAtom: expected L0 atom, got ${sourceAtom.layer} (id=${String(sourceAtom.id)})`,
    );
  }

  const llmOpts: LlmOptions = { ...DEFAULT_LLM_OPTIONS, ...(options.llm ?? {}) };
  const minConfidence = options.minConfidence ?? 0.3;
  const inherit = options.inheritSourcePrincipal ?? true;
  const attributionPrincipal = inherit ? sourceAtom.principal_id : options.principalId;

  const errors: string[] = [];
  const writtenAtomIds: AtomId[] = [];
  let claimsFound = 0;
  let atomsDeduped = 0;
  let atomsBelowThreshold = 0;

  let result: ExtractClaimsOutput;
  try {
    const judge = await host.llm.judge<ExtractClaimsOutput>(
      EXTRACT_CLAIMS.jsonSchema,
      EXTRACT_CLAIMS.systemPrompt,
      { content: sourceAtom.content, type: sourceAtom.type, layer: sourceAtom.layer },
      llmOpts,
    );
    result = EXTRACT_CLAIMS.zodSchema.parse(judge.output);
  } catch (err) {
    errors.push(`judge: ${err instanceof Error ? err.message : String(err)}`);
    return {
      sourceAtomId: sourceAtom.id,
      claimsFound: 0,
      atomsWritten: 0,
      atomsDeduped: 0,
      atomsBelowThreshold: 0,
      errors,
      writtenAtomIds,
    };
  }

  claimsFound = result.claims.length;

  for (const claim of result.claims) {
    if (claim.confidence < minConfidence) {
      atomsBelowThreshold += 1;
      continue;
    }

    const contentHash = host.atoms.contentHash(claim.content).slice(0, 16);
    const atomId = `l1-${String(sourceAtom.id).slice(0, 8)}-${contentHash}` as AtomId;
    const now = host.clock.now() as Time;

    const l1Atom: Atom = {
      schema_version: 1,
      id: atomId,
      content: claim.content,
      type: claim.type as AtomType,
      layer: 'L1',
      provenance: {
        kind: 'llm-refined',
        source: {
          tool: 'claim-extractor',
          ...(sourceAtom.provenance.source.session_id !== undefined
            ? { session_id: sourceAtom.provenance.source.session_id }
            : {}),
        },
        derived_from: [sourceAtom.id],
      },
      confidence: claim.confidence,
      created_at: now,
      last_reinforced_at: now,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: sourceAtom.scope,
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'unchecked',
        last_validated_at: null,
      },
      principal_id: attributionPrincipal,
      taint: 'clean',
      metadata: {
        extractor: 'extract-claims-v1',
        source_atom_id: sourceAtom.id,
      },
    };

    try {
      await host.atoms.put(l1Atom);
      writtenAtomIds.push(atomId);
    } catch (err) {
      if (err instanceof ConflictError) {
        atomsDeduped += 1;
      } else {
        errors.push(`put ${String(atomId)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await host.auditor.log({
    kind: 'extraction.applied',
    principal_id: options.principalId,
    timestamp: host.clock.now() as Time,
    refs: { atom_ids: [sourceAtom.id, ...writtenAtomIds] },
    details: {
      claims_found: claimsFound,
      atoms_written: writtenAtomIds.length,
      atoms_deduped: atomsDeduped,
      atoms_below_threshold: atomsBelowThreshold,
    },
  });

  return {
    sourceAtomId: sourceAtom.id,
    claimsFound,
    atomsWritten: writtenAtomIds.length,
    atomsDeduped,
    atomsBelowThreshold,
    errors,
    writtenAtomIds,
  };
}

export interface ExtractionPassOptions extends ExtractClaimsOptions {
  /** Max L0 atoms to process in one pass. Default 100. */
  readonly maxAtoms?: number;
  /**
   * AtomFilter narrowing the L0 set. Default: `{ layer: ['L0'] }`. Caller can
   * pass `{ layer: ['L0'], principal_id: [someAgent] }` to scope to one agent.
   */
  readonly filter?: AtomFilter;
  /**
   * If true, L0 atoms that already have L1 children (via derived_from) are
   * skipped. Default true; set false to re-extract (will dedup at put).
   */
  readonly skipIfAlreadyExtracted?: boolean;
}

export interface ExtractionPassReport {
  readonly sourcesScanned: number;
  readonly sourcesExtracted: number;
  readonly sourcesSkipped: number;
  readonly totalClaimsWritten: number;
  readonly totalDedup: number;
  readonly errors: ReadonlyArray<string>;
  readonly perSource: ReadonlyArray<ExtractionReport>;
}

/**
 * Run a bulk extraction pass over all L0 atoms matching `options.filter`.
 * Skips atoms that already have L1 children (unless `skipIfAlreadyExtracted`
 * is explicitly false). Safe to call repeatedly; dedup keeps state clean.
 */
export async function runExtractionPass(
  host: Host,
  options: ExtractionPassOptions,
): Promise<ExtractionPassReport> {
  const filter: AtomFilter = options.filter ?? { layer: ['L0'] };
  const max = options.maxAtoms ?? 100;
  const skipIfExtracted = options.skipIfAlreadyExtracted ?? true;

  const page = await host.atoms.query(filter, max);
  const perSource: ExtractionReport[] = [];
  const aggregateErrors: string[] = [];
  let sourcesExtracted = 0;
  let sourcesSkipped = 0;
  let totalClaimsWritten = 0;
  let totalDedup = 0;

  for (const source of page.atoms) {
    if (source.layer !== 'L0') {
      sourcesSkipped += 1;
      continue;
    }

    if (skipIfExtracted) {
      const existingChildren = await host.atoms.query(
        { layer: ['L1'] },
        500,
      );
      const hasChildren = existingChildren.atoms.some(
        (a) => a.provenance.derived_from.includes(source.id),
      );
      if (hasChildren) {
        sourcesSkipped += 1;
        continue;
      }
    }

    let report: ExtractionReport;
    try {
      report = await extractClaimsFromAtom(source, host, options);
    } catch (err) {
      aggregateErrors.push(
        `source ${String(source.id)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    perSource.push(report);
    sourcesExtracted += 1;
    totalClaimsWritten += report.atomsWritten;
    totalDedup += report.atomsDeduped;
  }

  return {
    sourcesScanned: page.atoms.length,
    sourcesExtracted,
    sourcesSkipped,
    totalClaimsWritten,
    totalDedup,
    errors: aggregateErrors,
    perSource,
  };
}
