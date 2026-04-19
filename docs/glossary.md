# Glossary

One-glance terminology reference. Keep in sync with framework.md.

| Term | Meaning |
|---|---|
| **Atom** | The unit of memory. Formal TS shape in `src/types.ts`: id, content, type, layer, provenance, confidence, timestamps, supersession refs, scope, signals, principal_id, taint, metadata. |
| **Drawer** | External ChromaDB palace terminology for a stored record. Synonymous with Atom at the semantic level. The bridge adapter bootstraps such records into LAG atoms. |
| **Layer** | Trust tier. L0 (raw), L1 (extracted), L2 (curated), L3 (canon). Atom.layer is immutable; PromotionEngine creates a new atom at the target layer with `provenance.kind='canon-promoted'` and supersedes the source. |
| **Canon** | L3. Rendered as a bracketed section (`<!-- lag:canon-start -->` / `<!-- lag:canon-end -->`) in a target markdown file by `CanonMdManager`. Human-signed via the L3 human-gate approval; rollback-able by un-committing and reverting. |
| **Principal** | Agent identity + role + permitted layers/scopes + goals/constraints. Persisted via `PrincipalStore`. `markCompromised(id, now, reason)` triggers taint propagation. |
| **Provenance** | Source chain of an atom. Kind (user-directive, agent-observed, agent-inferred, llm-refined, canon-promoted) + source (session, agent, tool, file_path) + `derived_from` (parent atom ids that feed the taint cascade). |
| **Arbitration** | Conflict resolution at write time. Rule stack: content-hash short-circuit, source-rank, temporal-scope, validation, escalation. Composed in `src/arbitration/index.ts`. |
| **Decay** | Scheduled decline of confidence with age. Exponential per-type half-life (directive: year; decision: 4 months; observation: 2 months; ephemeral: 1 week). Skips `taint !== 'clean'` atoms. |
| **Reinforcement** | Same fact seen again. Bumps confidence (patch.confidence) and `last_reinforced_at`. Counted toward consensus. |
| **Validation** | Pluggable re-check via `ValidatorRegistry`. Verdicts: verified / invalid / unverifiable. Blocks promotion when `requireValidation=true` and validator returns `invalid`. |
| **Promotion** | Atom moves upward: L1 -> L2 -> L3. Gated by `DEFAULT_THRESHOLDS`: L2 needs confidence >= 0.7 + consensus >= 2; L3 needs confidence >= 0.9 + consensus >= 3 + human approval. |
| **Supersession** | Winner of arbitration is preferred; loser has `superseded_by` set, retained for audit. Default queries exclude superseded; `query({superseded: true})` includes them. |
| **Taint** | `clean` / `tainted` / `quarantined`. Principal compromise -> direct taint on their post-compromise atoms, then transitive taint across `derived_from` to fixpoint via `propagateCompromiseTaint`. TTL expiration -> quarantined. Excluded from canon + promotion. |
| **Scope** | Visibility boundary: session / project / user / global. Enforced by `PrincipalStore.permits(principal, action, target)`. |
| **Consensus** | Count of distinct `principal_id` values across atoms sharing a content hash. Measured by `PromotionEngine.findCandidates`. |
| **Autonomy dial** | Operator controls `requireHumanApproval` in `LayerThresholds` and `l3HumanGateTimeoutMs` in LoopRunner. Same architecture across levels; only the threshold changes. |
| **Embedder** | Pluggable retrieval backend. Three ship: TrigramEmbedder (default, zero deps), OnnxMiniLmEmbedder (local `all-MiniLM-L6-v2`, 384-dim), CachingEmbedder (decorator, disk-persistent cache). See `docs/framework.md` Retrieval. |
| **Host** | The boundary between LAG logic and any concrete store. Eight interfaces (AtomStore, CanonStore, LLM, Notifier, Scheduler, Auditor, PrincipalStore, Clock) composed by `createMemoryHost` / `createFileHost` / `createBridgeHost`. LAG never reaches around the Host. |
