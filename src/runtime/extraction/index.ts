/**
 * Claim extraction module (Phase 43).
 *
 * Turns L0 raw atoms (ingested transcripts, captured observations,
 * tool outputs) into L1 structured claims via the LLM judge with the
 * EXTRACT_CLAIMS schema. One L0 atom can produce 0-10 L1 atoms; each
 * L1 carries `provenance.derived_from: [sourceId]` so lineage back to
 * the raw material survives indefinitely.
 *
 * Idempotent via content-hash dedup at the AtomStore layer: running
 * the pass twice on the same input writes no new atoms the second
 * time. Two different L0 sources that yield the same claim collapse
 * to one L1 atom, which is how consensus emerges organically.
 *
 * Cost-aware: per-atom judge calls use Haiku by default with a 0.5
 * USD budget ceiling. Skip L0 atoms that already have L1 children
 * (opt-out available for re-extraction).
 */

export {
  extractClaimsFromAtom,
  runExtractionPass,
  type ExtractClaimsOptions,
  type ExtractionPassOptions,
  type ExtractionReport,
  type ExtractionPassReport,
} from './extract.js';
