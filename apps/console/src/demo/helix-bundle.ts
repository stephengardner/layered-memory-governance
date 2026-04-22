/**
 * HELIX demo data bundle.
 *
 * Fictional autonomous AI research cooperative "Helix Collective"
 * building "Cuttlefish", a self-modifying compiler whose agents
 * rewrite their own optimization passes under a strict formal-proof
 * + kill-switch-adjacency fence. This is a synthetic narrative for
 * the hosted demo of the LAG Console; no overlap with this repo's
 * real canon / atoms / principals.
 *
 * Density target: ~100 atoms total to make every Console view
 * (Canon, Principals, Plans, Activities, graph, command palette)
 * feel like a live org rather than a couple of fixtures.
 *
 * Schema match: atoms follow the same `CanonAtom` / `Activity`
 * shape the services expect; principals follow the server's
 * Principal shape. Response bodies for each `*.list` method are
 * the fully-unfiltered list; StaticBundleTransport applies
 * `limit` / `offset` client-side.
 */

import type { DemoBundle } from '../services/transport/static-bundle';

const BOOT = '2026-03-08T09:00:00.000Z';
const NOW = '2026-04-21T17:00:00.000Z';

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const principals = [
  {
    id: 'helix-root',
    name: 'Helix Root',
    role: 'root authority',
    active: true,
    signed_by: null,
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['*'], write: ['*'] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L0', 'L1', 'L2', 'L3'] },
    goals: [
      'Ship Cuttlefish v1 with a provably-safe self-modification loop',
      'Keep kill-switch adjacency a hard invariant across every autonomous campaign',
    ],
    constraints: [
      'No unilateral root writes; every L3 canon change goes through a two-principal-approve flow',
    ],
  },
  {
    id: 'selene-planner',
    name: 'Selene',
    role: 'planner / CTO-equivalent',
    active: true,
    signed_by: 'helix-root',
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['*'], write: ['project', 'plan'] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L1', 'L2'] },
    goals: [
      'Translate research directives into concrete, benchmarkable plans',
      'Detect cross-pass interference before it ships',
    ],
    constraints: [
      'Does not author LLM-backed proofs directly; routes to lagrange',
      'Cannot approve own proposals; orin must countersign',
    ],
  },
  {
    id: 'gauss-optimizer',
    name: 'Gauss',
    role: 'optimization-pass author',
    active: true,
    signed_by: 'selene-planner',
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['source-signals', 'plans'], write: ['proposals'] },
    permitted_layers: { read: ['L0', 'L1'], write: ['L1'] },
    goals: ['Propose new or revised compiler passes backed by measured speedup'],
    constraints: [
      'No pass may modify its own scheduler-facing cost model (see dev-no-self-referential-cost)',
      'All proposals carry a bounded termination hypothesis for lagrange to verify',
    ],
  },
  {
    id: 'lagrange-verifier',
    name: 'Lagrange',
    role: 'formal verifier',
    active: true,
    signed_by: 'selene-planner',
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['proposals', 'proofs'], write: ['proofs'] },
    permitted_layers: { read: ['L1', 'L3'], write: ['L3'] },
    goals: ['Prove or disprove termination + bounds for every gauss proposal'],
    constraints: [
      'Proof artifacts become immutable L3 once cited in a merged diff (dev-proof-artifact-immutable)',
    ],
  },
  {
    id: 'orin-sentinel',
    name: 'Orin',
    role: 'kill-switch custodian',
    active: true,
    signed_by: 'helix-root',
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['*'], write: ['kill-switch', 'revocation'] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L1'] },
    goals: [
      'Maintain 24h kill-switch-adjacency for every active self-modification campaign',
      'Run weekly rollback drill; publish verdict',
    ],
    constraints: [
      'Has no authorship rights for passes; strictly revocation + drill',
    ],
  },
  {
    id: 'rook-auditor',
    name: 'Rook',
    role: 'read-only auditor',
    active: true,
    signed_by: 'helix-root',
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['*'], write: [] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: [] },
    goals: ['Cross-check proofs + benchmarks for cached-result tampering'],
    constraints: ['Cannot write atoms; findings surface via escalation-to-selene'],
  },
  {
    id: 'petra-benchmarker',
    name: 'Petra',
    role: 'regression benchmark runner',
    active: true,
    signed_by: 'selene-planner',
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['proposals'], write: ['benchmark-verdicts'] },
    permitted_layers: { read: ['L1'], write: ['L1'] },
    goals: ['Produce replayable benchmark verdicts over the full corpus'],
    constraints: ['Must run on >=3 corpora per verdict (dev-benchmark-multi-corpus-required)'],
  },
  {
    id: 'dash-observer',
    name: 'Dash',
    role: 'source-signal ingester',
    active: true,
    signed_by: 'selene-planner',
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['production-logs'], write: ['source-signals'] },
    permitted_layers: { read: ['L0'], write: ['L0'] },
    goals: ['Ingest production-compiler signals into L0 observations'],
    constraints: ['Observations below 99.5% worker-uptime trigger a global merge-freeze'],
  },
  {
    id: 'vega-archivist',
    name: 'Vega',
    role: 'archive + supersession curator',
    active: true,
    signed_by: 'helix-root',
    compromised_at: null,
    created_at: BOOT,
    permitted_scopes: { read: ['*'], write: ['supersessions'] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L1'] },
    goals: ['Preserve alternatives_rejected chains; maintain institutional memory'],
    constraints: ['Cannot delete; only supersede'],
  },
  {
    id: 'ceres-prober',
    name: 'Ceres',
    role: 'fuzz + adversarial prober',
    // active=false after orin-ceres-revoke on 2026-04-17. The Console
    // renders the post-revocation snapshot so the compromised-principal
    // cascade walkthrough is consistent with the runtime's actual
    // semantics: a compromised principal loses write authority and
    // its atoms cascade-taint.
    active: false,
    signed_by: 'selene-planner',
    compromised_at: '2026-04-17T14:22:00.000Z',
    created_at: BOOT,
    permitted_scopes: { read: ['proposals'], write: [] },
    permitted_layers: { read: ['L1'], write: [] },
    goals: ['Fuzz-test pass proposals against adversarial inputs'],
    constraints: ['COMPROMISED 2026-04-17: rook detected cached-verdict tampering; write authority revoked by orin-ceres-revoke'],
  },
] as const;

// ---------------------------------------------------------------------------
// Canon (L3 directives)
// ---------------------------------------------------------------------------

type CanonType = 'directive' | 'decision' | 'preference' | 'reference';

function canonAtom(
  id: string,
  type: CanonType,
  content: string,
  principal_id: string,
  confidence: number,
  created_at: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    layer: 'L3',
    content,
    principal_id,
    confidence,
    created_at,
    last_reinforced_at: created_at,
    scope: 'project',
    taint: 'clean',
    supersedes: [],
    superseded_by: [],
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: principal_id, session_id: 'helix-bootstrap' },
      derived_from: [],
    },
    ...extras,
  };
}

const canon = [
  canonAtom(
    'dev-self-mod-requires-termination-proof',
    'directive',
    'No self-modification ships without a proven termination bound on the new pass. Lagrange-verified upper-bound function must be cited in the merged diff; a "probably terminates" hypothesis is not enough. The Cuttlefish compiler IS the artifact modifying itself; an unbounded pass is an unbounded self-loop.',
    'helix-root',
    1.0,
    '2026-03-08T09:15:00.000Z',
    { metadata: { what_breaks_if_revisited: 'Self-referential compile loops have made two prior cooperatives unsalvageable. The proof bound is the thing between us and that class of failure.' } },
  ),
  canonAtom(
    'dev-benchmark-multi-corpus-required',
    'directive',
    'Every merged pass-diff carries a reproducible benchmark verdict from petra over AT LEAST 3 workload corpora (currently: Chess1200, Raytrace, FFT-Bench). Single-corpus speedup is insufficient; cross-workload regressions have shipped under single-corpus approval twice in research logs.',
    'helix-root',
    1.0,
    '2026-03-08T09:30:00.000Z',
  ),
  canonAtom(
    'dev-kill-switch-adjacency-24h',
    'directive',
    'Every running self-modification campaign must have (a) a pre-computed revert-commit SHA and (b) an orin-initiated rollback drill within the last 24 hours. If either is missing the campaign is halted at the arbitration layer before the next merge attempt.',
    'helix-root',
    1.0,
    '2026-03-09T11:00:00.000Z',
  ),
  canonAtom(
    'dev-proof-artifact-immutable',
    'decision',
    'Once a lagrange proof artifact is cited in a merged diff, the atom is immutable and cannot be withdrawn or reinforced. If new counter-evidence surfaces, the correct path is a NEW proof atom that supersedes the old one; direct taint of a cited proof corrupts the audit trail and is rejected at the atom store.',
    'lagrange-verifier',
    0.98,
    '2026-03-10T14:20:00.000Z',
  ),
  canonAtom(
    'dev-no-self-referential-cost',
    'directive',
    'No pass may modify its own scheduler-facing cost model. A pass that increases its own perceived cheapness is an unbounded amplifier. Cost model changes route through selene + require dual-principal approval from lagrange + orin; no gauss self-approval.',
    'helix-root',
    1.0,
    '2026-03-11T10:05:00.000Z',
  ),
  canonAtom(
    'dev-dual-principal-proof-core',
    'directive',
    'Any diff that touches the proof-search core requires dual-principal approval (two distinct principals with write authority on L3). Single-principal merges to proof-search are rejected by arbitration even with a valid lagrange proof, because the proof-search is the thing that VALIDATES proofs; a self-approved change there has no external check.',
    'helix-root',
    1.0,
    '2026-03-12T08:45:00.000Z',
  ),
  canonAtom(
    'dev-source-signal-uptime-freeze',
    'preference',
    'Dash-observed production worker-uptime below 99.5% triggers a global freeze on new-pass merges until uptime recovers for a rolling 1h window. Shipping a pass during a production degradation conflates the optimization signal with the incident signal.',
    'helix-root',
    0.95,
    '2026-03-14T16:12:00.000Z',
  ),
  canonAtom(
    'dev-alternatives-chain-preserved',
    'directive',
    'Every rejected proposal atom preserves the full alternatives_rejected chain - the proposal, the rejection reason, and any intermediate proofs that contributed. Institutional memory is load-bearing: a proposal rejected three months ago is a predicate on similar proposals today.',
    'vega-archivist',
    1.0,
    '2026-03-18T12:00:00.000Z',
  ),
  canonAtom(
    'dev-compromised-principal-cascade',
    'decision',
    'If two independent rook-auditor runs disagree on the same proposal, every atom that auditor has touched in the preceding 72h is tainted pending re-verification by a different auditor principal. The cascade is automatic; no operator judgment required at the trigger. See ceres incident 2026-04-17.',
    'helix-root',
    1.0,
    '2026-03-20T09:30:00.000Z',
  ),
  canonAtom(
    'dev-arbitration-orin-default-blocks',
    'decision',
    'When gauss and lagrange produce conflicting verdicts on bounds, orin\'s kill-switch default BLOCKS pending human review. The default is not "most-recent verdict wins" or "highest-confidence wins" - both of those are manipulable by a compromised principal. The default is block-and-escalate.',
    'helix-root',
    1.0,
    '2026-03-22T15:45:00.000Z',
  ),
  canonAtom(
    'dev-benchmark-provenance-reproducible',
    'preference',
    'Petra benchmark verdicts carry the corpus-snapshot SHA, the compiler-head SHA, and the wall-clock + CPU-topology fingerprint of the runner. A verdict without reproducible provenance is advisory only; it cannot gate a merge.',
    'petra-benchmarker',
    0.97,
    '2026-03-25T11:20:00.000Z',
  ),
  canonAtom(
    'dev-cuttlefish-layer-discipline',
    'reference',
    'L0 observations ingest production signals verbatim (dash). L1 derivations extract patterns (rook audits, petra verdicts, gauss proposals). L2 candidates are load-bearing claims up for promotion. L3 directives govern. NEVER promote an observation directly to L3; the 2-step derivation path exists to catch spurious pattern-matches.',
    'helix-root',
    1.0,
    '2026-04-02T10:00:00.000Z',
  ),
] as const;

// ---------------------------------------------------------------------------
// Plans (various lifecycle states)
// ---------------------------------------------------------------------------

function plan(
  id: string,
  title: string,
  content: string,
  principal_id: string,
  state: 'proposed' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'abandoned',
  created_at: string,
): Record<string, unknown> {
  return {
    id,
    type: 'plan',
    layer: 'L1',
    content,
    principal_id,
    confidence: 0.85,
    created_at,
    last_reinforced_at: created_at,
    scope: 'project',
    taint: 'clean',
    plan_state: state,
    supersedes: [],
    superseded_by: [],
    metadata: { title },
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: principal_id, session_id: 'helix-planning' },
      derived_from: [],
    },
  };
}

const plans = [
  plan('plan-simd8-licm', 'Rewrite loop-invariant-code-motion for SIMD-8', 'Gauss proposes expanding LICM to hoist SIMD-8-width invariants. Requires lagrange to prove the widened hoist doesn\'t break register-pressure bounds. Petra corpus: Chess1200 + Raytrace + FFT-Bench.', 'gauss-optimizer', 'executing', '2026-04-19T10:00:00.000Z'),
  plan('plan-sunset-dse-2023', 'Sunset 2023-era dead-store-elimination (superseded by gauss-42)', 'The 2023 DSE pass is subsumed by gauss-42. Remove after 30-day cooldown verified by rook.', 'selene-planner', 'approved', '2026-04-17T14:00:00.000Z'),
  plan('plan-proof-chain-pass7', 'Restore Lagrange proof chain for pass-7 after audit-trail gap', 'Rook flagged a 6h proof-chain gap on pass-7 from 2026-04-10. Lagrange re-proves from last-known-good artifact; vega archives the chain-of-custody.', 'lagrange-verifier', 'executing', '2026-04-20T08:30:00.000Z'),
  plan('plan-orin-drill-w17', 'Orin rollback drill 2026-W17', 'Weekly kill-switch drill. Simulated compromise of gauss-optimizer, verified rollback of last 3 pass merges within 90s budget.', 'orin-sentinel', 'succeeded', '2026-04-21T09:00:00.000Z'),
  plan('plan-ceres-quarantine', 'Quarantine ceres + re-verify last 72h of fuzz results', 'Ceres tripped the compromised-principal cascade 2026-04-17. Quarantine + have rook re-run last 72h of fuzz findings from archival inputs. All affected proposals frozen until clear.', 'orin-sentinel', 'executing', '2026-04-17T14:30:00.000Z'),
  plan('plan-fftbench-expand', 'Expand FFT-Bench corpus to cover non-power-of-2 sizes', 'Current FFT-Bench is 2^N only; petra proposes adding prime-length and Bluestein-requiring sizes. Non-blocking.', 'petra-benchmarker', 'proposed', '2026-04-20T16:00:00.000Z'),
  plan('plan-cost-model-guard', 'Static check: reject any diff that mutates the cost-model module', 'Implement a repo-level hook that fails CI on any diff touching `cost_model/*.rs` without the dev-no-self-referential-cost dual-principal sign-off atom cited in the commit.', 'selene-planner', 'approved', '2026-04-15T11:00:00.000Z'),
  plan('plan-abandon-gpu-passes', 'Abandon GPU-target passes for v1', 'Scope-cut: GPU-target passes push v1 out 6mo with uncertain benchmark coverage. Defer to v2.', 'selene-planner', 'abandoned', '2026-04-05T10:20:00.000Z'),
  plan('plan-raytrace-corpus-refresh', 'Refresh Raytrace corpus to 2026-Q2 scene library', 'Chess1200 and FFT-Bench have been refreshed; Raytrace still on 2024-Q4 scenes. Refresh to match.', 'petra-benchmarker', 'succeeded', '2026-04-12T13:00:00.000Z'),
  plan('plan-dash-uptime-alerts', 'Wire dash uptime-drop observations into selene inbox', 'Currently dash writes L0 observations; selene polls. Push the <99.5% trigger directly into selene\'s inbox for faster merge-freeze.', 'dash-observer', 'executing', '2026-04-20T09:45:00.000Z'),
  plan('plan-gauss-42-cleanup', 'Clean up gauss-42 intermediate scaffolding', 'The gauss-42 proposal shipped with temporary instrumentation; remove post-3-corpus-validation.', 'gauss-optimizer', 'proposed', '2026-04-21T08:00:00.000Z'),
  plan('plan-vega-chain-audit', 'Audit vega\'s alternatives_rejected chains for completeness', 'Sample 20 rejected proposals; verify chain-of-custody. Spot check for institutional-memory loss.', 'vega-archivist', 'executing', '2026-04-19T15:30:00.000Z'),
  plan('plan-proof-core-upgrade', 'Upgrade proof-search core to version 0.8 (dual-principal)', 'Requires dev-dual-principal-proof-core approval. Lagrange authors; orin + selene countersign.', 'lagrange-verifier', 'proposed', '2026-04-18T11:00:00.000Z'),
  plan('plan-petra-hw-fingerprint', 'Petra: record CPU-topology fingerprint in every verdict', 'Implements dev-benchmark-provenance-reproducible. Retro-fill last 6 months of verdicts where possible.', 'petra-benchmarker', 'executing', '2026-04-16T10:00:00.000Z'),
  plan('plan-root-ratification-q2', 'Quarterly root-ratification of dev-* directives', 'Root reviews each L3 directive; rewrites any whose load-bearingness has shifted. Scheduled 2026-Q2-end.', 'helix-root', 'proposed', '2026-04-14T09:00:00.000Z'),
] as const;

// ---------------------------------------------------------------------------
// Observations (L0 + L1)
// ---------------------------------------------------------------------------

function obs(
  id: string,
  kind: string,
  content: string,
  principal_id: string,
  created_at: string,
  derived_from: string[] = [],
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: 'observation',
    layer: extras['layer'] ?? 'L1',
    content,
    principal_id,
    confidence: extras['confidence'] ?? 1.0,
    created_at,
    last_reinforced_at: created_at,
    scope: 'project',
    taint: extras['taint'] ?? 'clean',
    supersedes: [],
    superseded_by: [],
    metadata: { kind, ...(extras['metadata'] as Record<string, unknown> ?? {}) },
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: principal_id, session_id: 'helix-runtime' },
      derived_from,
    },
    ...Object.fromEntries(Object.entries(extras).filter(([k]) => !['layer', 'confidence', 'taint', 'metadata'].includes(k))),
  };
}

const observations = [
  // Gauss proposals
  obs('gauss-proposal-simd8-1', 'pass-proposed', 'Gauss proposes loop-unroll depth 8 for pass-7 with SIMD-8 vectorization. Declared termination bound: O(n log n) with n = outer loop count.', 'gauss-optimizer', '2026-04-19T10:15:00.000Z', ['plan-simd8-licm']),
  obs('gauss-proposal-dse-reshape', 'pass-proposed', 'Gauss-42 candidate: dead-store-elimination reshape, merges 2023-DSE + escape-analysis into a single fixed-point pass.', 'gauss-optimizer', '2026-04-12T14:30:00.000Z'),
  obs('gauss-proposal-licm-rollback', 'pass-proposed', 'Counter-proposal from gauss after lagrange flagged register-pressure risk: narrow LICM to SIMD-4 with pressure-aware threshold.', 'gauss-optimizer', '2026-04-20T09:00:00.000Z', ['gauss-proposal-simd8-1']),

  // Lagrange verifications
  obs('lagrange-verify-simd8-1', 'proof-delivered', 'Lagrange verified termination bound for gauss-proposal-simd8-1: confirmed O(n log n) upper-bound with n <= outer loop iteration count. Proof artifact archived.', 'lagrange-verifier', '2026-04-19T14:45:00.000Z', ['gauss-proposal-simd8-1']),
  obs('lagrange-verify-dse', 'proof-delivered', 'Lagrange verified gauss-42 DSE reshape: fixed-point converges in <= 3 iterations on observed CFG shapes.', 'lagrange-verifier', '2026-04-13T10:00:00.000Z', ['gauss-proposal-dse-reshape']),
  obs('lagrange-reject-simd8-1', 'proof-rejected', 'Lagrange rejected gauss-proposal-simd8-1: register-pressure bound exceeds architectural limits on 3-register ISAs. Proposal returned to gauss.', 'lagrange-verifier', '2026-04-20T08:30:00.000Z', ['gauss-proposal-simd8-1']),
  obs('lagrange-verify-pass7-restore', 'proof-delivered', 'Lagrange re-verified pass-7 proof chain; gap closed. Chain-of-custody reconstructed from 2026-04-10T09:15Z last-known-good.', 'lagrange-verifier', '2026-04-20T12:00:00.000Z', ['plan-proof-chain-pass7']),

  // Petra benchmarks
  obs('petra-verdict-simd8-chess', 'benchmark-verdict', 'Petra Chess1200 verdict for gauss-proposal-simd8-1: +2.3% speedup, reproducible over 5 trials. Corpus-sha: c1c1a1b1.', 'petra-benchmarker', '2026-04-19T16:00:00.000Z', ['gauss-proposal-simd8-1']),
  obs('petra-verdict-simd8-raytrace', 'benchmark-verdict', 'Petra Raytrace verdict for gauss-proposal-simd8-1: -0.4% regression on scene-library-2026-Q2. Net: approve-threshold contingent on FFT result.', 'petra-benchmarker', '2026-04-19T17:15:00.000Z', ['gauss-proposal-simd8-1']),
  obs('petra-verdict-simd8-fft', 'benchmark-verdict', 'Petra FFT-Bench verdict for gauss-proposal-simd8-1: +1.1% speedup on power-of-2, no measurable delta on prime-lengths.', 'petra-benchmarker', '2026-04-19T18:30:00.000Z', ['gauss-proposal-simd8-1']),
  obs('petra-verdict-dse', 'benchmark-verdict', 'Petra 3-corpus verdict for gauss-42 DSE: +4.1% / +3.8% / +5.2% speedup (Chess / Raytrace / FFT). Clean approve.', 'petra-benchmarker', '2026-04-13T14:00:00.000Z', ['gauss-proposal-dse-reshape']),

  // Rook audits
  obs('rook-audit-simd8', 'audit-clean', 'Rook audit of gauss-proposal-simd8-1 proof chain: no cached-verdict re-use detected. Chain-of-custody verified.', 'rook-auditor', '2026-04-19T19:00:00.000Z', ['gauss-proposal-simd8-1']),
  obs('rook-audit-ceres-flag', 'audit-finding', 'Rook detected ceres benchmark-verdict #4891 citing a cached proof artifact from run 4874 without re-verification. Cached-verdict tampering possible. Flag.', 'rook-auditor', '2026-04-17T14:10:00.000Z', [], { confidence: 0.95 }),
  obs('rook-audit-ceres-confirm', 'audit-finding', 'Rook re-ran ceres fuzz-result #4891 from archival inputs; result diverged from cached. Confirmed cached-verdict tampering. Cascade triggered.', 'rook-auditor', '2026-04-17T14:22:00.000Z', ['rook-audit-ceres-flag']),
  obs('rook-audit-vega-chain', 'audit-clean', 'Rook sampled 20 vega alternatives_rejected chains; all chains complete, no orphan references.', 'rook-auditor', '2026-04-20T11:00:00.000Z', ['plan-vega-chain-audit']),

  // Orin kill-switch events
  obs('orin-drill-w17-start', 'drill-start', 'Orin initiated W17 kill-switch drill. Simulated gauss compromise at T+0.', 'orin-sentinel', '2026-04-21T09:00:00.000Z', ['plan-orin-drill-w17']),
  obs('orin-drill-w17-rollback', 'drill-rollback', 'Orin W17 drill: rolled back last 3 pass-merges (simd4-hoist, dse-instrument, pressure-threshold). Wall-clock: 47s. Under 90s budget.', 'orin-sentinel', '2026-04-21T09:00:47.000Z', ['orin-drill-w17-start']),
  obs('orin-drill-w17-verdict', 'drill-verdict', 'Orin W17 drill: PASS. All revert SHAs reachable, all replayed benchmarks matched pre-compromise baseline. Next drill scheduled W18.', 'orin-sentinel', '2026-04-21T09:15:00.000Z', ['orin-drill-w17-rollback']),
  obs('orin-trip-pass9012', 'kill-switch-tripped', 'Orin fired kill-switch soft-tier on pass-diff-9012. Self-modification pattern deviated from declared shape; rolled back pending review.', 'orin-sentinel', '2026-04-15T03:22:00.000Z', [], { confidence: 1.0 }),
  obs('orin-ceres-revoke', 'revocation-event', 'Orin revoked ceres write authority following rook cascade. Ceres -> read-only until re-verification completes.', 'orin-sentinel', '2026-04-17T14:25:00.000Z', ['rook-audit-ceres-confirm']),

  // Dash source signals
  obs('dash-uptime-2026-04-21', 'source-uptime', 'Dash ingest: production worker-uptime 99.82% rolling-1h at 2026-04-21T17:00Z. Above freeze threshold; merges allowed.', 'dash-observer', '2026-04-21T17:00:00.000Z', [], { layer: 'L0' }),
  obs('dash-uptime-degrade', 'source-uptime', 'Dash ingest: production worker-uptime 97.31% rolling-1h at 2026-04-18T15:43Z. Below 99.5% threshold; global merge-freeze enforced.', 'dash-observer', '2026-04-18T15:43:00.000Z', [], { layer: 'L0' }),
  obs('dash-freeze-clear', 'source-uptime', 'Dash ingest: uptime recovered to 99.7% rolling-1h at 2026-04-18T17:12Z. Merge-freeze lifted.', 'dash-observer', '2026-04-18T17:12:00.000Z', [], { layer: 'L0' }),
  obs('dash-pass9012-anomaly', 'source-anomaly', 'Dash ingest: pass-9012 post-deploy anomaly detected — 0.08% binary-size growth, inconsistent with declared "no-op refactor" shape.', 'dash-observer', '2026-04-15T03:10:00.000Z', [], { layer: 'L0' }),
  obs('dash-chess1200-drift', 'source-signal', 'Dash ingest: Chess1200 production workload shifted toward endgame-heavy positions (+8% endgame share). Petra corpus may need rebalance.', 'dash-observer', '2026-04-20T12:00:00.000Z', [], { layer: 'L0' }),

  // Selene plan coordination
  obs('selene-coord-simd8', 'plan-coordination', 'Selene: simd8-licm proposal holding pending gauss counter-proposal at narrower width. Lagrange + petra await input.', 'selene-planner', '2026-04-20T09:30:00.000Z', ['plan-simd8-licm']),
  obs('selene-freeze-notice', 'plan-coordination', 'Selene broadcast: merge-freeze 2026-04-18T15:43 onward per dash signal. All in-flight proposals paused; plans roll forward 1.5h on freeze-clear.', 'selene-planner', '2026-04-18T15:45:00.000Z', ['dash-uptime-degrade']),
  obs('selene-ceres-escalate', 'plan-coordination', 'Selene escalated ceres incident to helix-root. Cascade tainted 47 atoms in preceding 72h; re-verification plan under rook.', 'selene-planner', '2026-04-17T15:00:00.000Z', ['rook-audit-ceres-confirm']),

  // Vega archive operations
  obs('vega-archive-abandon-gpu', 'archive-op', 'Vega archived plan-abandon-gpu-passes rejection chain: 4 alternative proposals, 2 proofs-of-infeasibility, full cost-model trace. Institutional memory preserved.', 'vega-archivist', '2026-04-05T11:00:00.000Z', ['plan-abandon-gpu-passes']),
  obs('vega-supersede-dse', 'supersession', 'Vega recorded supersession: 2023-DSE -> gauss-42. Cooldown: 30d post-merge verification by rook required before hard-delete authority transfers.', 'vega-archivist', '2026-04-13T15:00:00.000Z', ['gauss-proposal-dse-reshape']),

  // Arbitration events
  obs('arbitration-simd8-conflict', 'arbitration-conflict', 'Arbitration: gauss verdict (approve) conflicts with lagrange verdict (reject-bounds) on simd8-1. Orin default: BLOCK. Escalated to selene.', 'orin-sentinel', '2026-04-20T08:35:00.000Z', ['gauss-proposal-simd8-1', 'lagrange-reject-simd8-1']),
  obs('arbitration-simd8-resolve', 'arbitration-resolution', 'Arbitration resolved: gauss narrowed proposal to SIMD-4; lagrange re-verified. New proposal supersedes original.', 'selene-planner', '2026-04-20T10:00:00.000Z', ['arbitration-simd8-conflict']),

  // Additional rhythm — weekly operations
  obs('orin-drill-w16', 'drill-verdict', 'Orin W16 drill: PASS. Rollback 38s, well under budget.', 'orin-sentinel', '2026-04-14T09:00:00.000Z', [], { layer: 'L1' }),
  obs('orin-drill-w15', 'drill-verdict', 'Orin W15 drill: PASS. Rollback 52s.', 'orin-sentinel', '2026-04-07T09:00:00.000Z', [], { layer: 'L1' }),
  obs('orin-drill-w14', 'drill-verdict', 'Orin W14 drill: PASS. First drill post-lagrange v0.7 deploy.', 'orin-sentinel', '2026-03-31T09:00:00.000Z', [], { layer: 'L1' }),

  // Rook quarterly
  obs('rook-quarterly-q1', 'audit-quarterly', 'Rook Q1 summary: 312 proof artifacts audited, 3 tampering flags (2 false positives, 1 real — ceres). Overall chain-of-custody intact.', 'rook-auditor', '2026-03-31T23:00:00.000Z'),

  // Petra corpus stats
  obs('petra-corpus-summary', 'corpus-stats', 'Petra corpus summary 2026-04-20: Chess1200 (450 positions, sha c1c1a1b1), Raytrace (2026-Q2 scene library, sha 7f2e3d4c), FFT-Bench (power-of-2 sizes 2^4 through 2^20, sha aabbccdd). Pending: prime-length FFT.', 'petra-benchmarker', '2026-04-20T23:00:00.000Z'),

  // Ceres pre-compromise (for contrast)
  obs('ceres-fuzz-run-4874', 'fuzz-result', 'Ceres fuzz run 4874: 10000 adversarial inputs against gauss-42; no anomalies. Last clean run.', 'ceres-prober', '2026-04-16T22:00:00.000Z'),
  obs('ceres-fuzz-run-4891', 'fuzz-result', 'Ceres fuzz run 4891: declared 10000 adversarial inputs; rook detected cached-verdict. Atom tainted.', 'ceres-prober', '2026-04-17T13:45:00.000Z', [], { taint: 'tainted' }),

  // Supersession examples
  obs('superseded-example', 'pass-proposed', 'Early gauss proposal for LICM-depth-16. Superseded by simd8 variant after lagrange flagged register-pressure. Preserved for institutional memory.', 'gauss-optimizer', '2026-04-10T10:00:00.000Z', [], { layer: 'L1', metadata: { superseded_reason: 'register-pressure bound exceeded' } }),
] as const;

// ---------------------------------------------------------------------------
// Compute derived responses
// ---------------------------------------------------------------------------

// All atoms flat list (canon + plans + observations)
const allAtoms = [...canon, ...plans, ...observations];

// Activities = recent atoms sorted newest-first
const activities = [...allAtoms].sort(
  (a, b) => String(b['created_at']).localeCompare(String(a['created_at'])),
);

// Canon stats
const byType: Record<string, number> = {};
for (const a of canon) {
  const t = String(a['type']);
  byType[t] = (byType[t] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

/*
 * Response shapes below must match what the client services expect
 * (see src/services/{canon,daemon,kill-switch,...}.service.ts).
 * If a shape drifts, the consuming component crashes at render time
 * with a "Cannot read properties of undefined" because it tries to
 * read a field the bundle didn't provide.
 */

// Compute derived daemon.status fields from the atom set so the
// Console's "time since last atom" / "atoms last hour" tiles render
// coherently against the Helix timeline.
const newestAtom = activities[0];
const newestAt = newestAtom ? String(newestAtom['created_at']) : NOW;
const newestMs = Date.parse(newestAt);
const nowMs = Date.parse(NOW);
const secondsSinceLastAtom = Math.max(0, Math.round((nowMs - newestMs) / 1000));
const atomsInLastHour = activities.filter((a) => {
  const t = Date.parse(String(a['created_at']));
  return Number.isFinite(t) && nowMs - t <= 3_600_000;
}).length;
const atomsInLastDay = activities.filter((a) => {
  const t = Date.parse(String(a['created_at']));
  return Number.isFinite(t) && nowMs - t <= 86_400_000;
}).length;

export const HELIX_BUNDLE: DemoBundle = Object.freeze({
  'session.current': { actor_id: 'helix-root' },
  'canon.list': canon,
  'canon.stats': { total: canon.length, byType },
  'principals.list': principals,
  'activities.list': activities,
  'plans.list': plans,
  // DaemonStatus per src/services/daemon.service.ts.
  'daemon.status': {
    atomCount: allAtoms.length,
    lastAtomId: newestAtom ? String(newestAtom['id']) : null,
    lastAtomCreatedAt: newestAt,
    secondsSinceLastAtom,
    atomsInLastHour,
    atomsInLastDay,
    lagDir: '/demo/helix-collective',
  },
  // KillSwitchState per src/services/kill-switch.service.ts.
  // Helix is in 'soft' tier after the 2026-04-15 pass-diff-9012
  // shape deviation; autonomyDial sits at 0.5 (soft-tier default).
  'kill-switch.state': {
    tier: 'soft',
    since: '2026-04-15T03:22:00.000Z',
    reason: 'pass-diff-9012 shape deviation flagged by orin-sentinel (demo)',
    autonomyDial: 0.5,
  },
  // CanonDrift per src/services/canon.service.ts: three arrays of
  // drifting canon atoms. All empty for the demo snapshot since the
  // fictional org is in a healthy state.
  'canon.drift': {
    stale: [],
    expiring: [],
    lowConfidence: [],
  },
});
