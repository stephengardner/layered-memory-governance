<!-- lag:canon-start -->
# LAG Canon

Auto-managed by LAG. Do NOT edit the auto-canon section; changes will be overwritten on the next canon application.

_Last updated: 2026-04-19T00:00:00.000Z_

## Directives

- Development decisions require extreme rigor and research before shipping. Never ship what is "mostly right" without sourced reasoning; prior atoms, DECISIONS entries, prior art, and external docs must be searched and weighed. Plans that skip this step are escalated. _(confidence 1.00)_
- Any agent or actor operating in this org is required to flag structural concerns proactively when a proposed path compromises pluggability, simple-surface, substrate discipline, or fit for consumers beyond our current scope. Silent execution of a shape-compromising decision is a violation; surfaced concerns are the right behaviour even when the concern is ultimately overruled. _(confidence 1.00)_
- Design decisions must survive a 3-month-later review without regret. Proposed plans must articulate how they will still be sound when the org has 10x more actors, 10x more canon, and an order of magnitude more external integrations. Plans that optimize for this week break later. _(confidence 1.00)_
- Artifacts shipped to this repo must not credit an AI assistant. Commits, PR bodies, PR comments, and any tracked file must not carry Co-Authored-By trailers or "Generated with" markers for Claude or any other AI. The assistant is a tool; authorship is the operator. This rule is strict and governs every future commit. _(confidence 1.00)_
- When a path is easy but compromises pluggability, composability, substrate discipline, or future-proofing, choose the right path instead. Surface the trade-off explicitly in the plan. The easy path without acknowledgment of what it costs is a plan failure. _(confidence 1.00)_
- LAG must be simple to describe to a human ("governance substrate for autonomous agents") while having architecture deep enough to support orgs running 50+ concurrent actors. Plans that add complexity to the surface or thin the architecture are rejected. Subpath imports, sharp hello-world stories, layered tutorials are mechanisms that serve this. _(confidence 1.00)_
- Framework code under src/ must stay mechanism-focused and pluggable. Role names, specific org shapes, vendor-specific logic, and our instance configuration belong in canon, skills, or examples, never in src/. Plans that encode our org shape into framework primitives are rejected. _(confidence 1.00)_
- Conflict detection must happen at write time via the arbitration stack. A nightly batch pass is always too late. The cost of real-time detection is an accepted trade. _(confidence 1.00)_
- Governance before autonomy. Build the deterministic rules, then tune the autonomy dial. Never the reverse. _(confidence 1.00)_
- Design the kill switch before moving the autonomy dial. Soft tier (STOP sentinel) is required; medium and hard tiers are roadmap but the seams are reserved. _(confidence 1.00)_
- L3 promotion requires human approval by default. The autonomy dial can auto-approve, but the gate is always present in the code path; you raise the dial, you do not remove the gate. _(confidence 1.00)_
- CI package-hygiene guard rejects private-term leaks and emdashes anywhere in tracked files. The specific term list lives in .github/workflows/ci.yml; do not echo those terms in source, docs, or committed canon. _(confidence 1.00)_
- Every atom must carry provenance with a source chain. No exceptions. Provenance pays back every hard question later (taint cascade, compromise response, audit). _(confidence 1.00)_

## Decisions

- The AtomStore is the single source of truth. Every other artifact (canon markdown, dashboards, audit reports, agent context) is a projection over the atom set. Never derive from or write to a projection directly. _(confidence 1.00)_
- Canon renders into a bracketed section of a target CLAUDE.md file via CanonMdManager. Content outside the markers is preserved byte-for-byte. Multi-target canon (one file per scope or role) composes via LoopRunner.canonTargets. _(confidence 1.00)_
- The Host interface is the sole boundary between framework logic and any concrete implementation. Eight sub-interfaces: AtomStore, CanonStore, LLM, Notifier, Scheduler, Auditor, PrincipalStore, Clock. LAG logic never reaches around this boundary. _(confidence 1.00)_
- The Notifier is a pluggable channel seam, not a hardcoded file queue. File queue is the V0 implementation; Telegram, Slack, session-inject, and email are channel implementations behind the same interface. Callers never branch on channel type. _(confidence 1.00)_
- Principals form a hierarchy via signed_by. Authority cascades from root down. Arbitration respects the chain (source-rank uses principal depth as a tiebreaker). Taint propagates transitively when a leaf is compromised. _(confidence 1.00)_
- Retrieval is a stack, not a single embedder. Trigram for cheap lexical recall, ONNX MiniLM for semantic, caching decorator for repeat queries. Users compose; the framework does not pick one winner. _(confidence 1.00)_

## Preferences

- Default L2 promotion threshold: distinct-principal consensus >= 2, confidence >= 0.7. No validator requirement. Override per-tenant via DEFAULT_THRESHOLDS. _(confidence 1.00)_
- Default L3 promotion threshold: distinct-principal consensus >= 3, confidence >= 0.9, plus human approval through the Notifier gate. Validators optional but encouraged. _(confidence 1.00)_
- MAX_PRINCIPAL_DEPTH = 9. Chains deeper than this are capped. Realistic org depth (human -> CEO -> VP -> director -> manager -> IC -> agent) is 6; 9 leaves headroom. _(confidence 1.00)_
- Source-rank scoring formula: Layer x 10000 + Provenance x 100 + (MAX_PRINCIPAL_DEPTH - depth) x 10 + floor(confidence x 10). Layer dominates provenance dominates hierarchy dominates confidence; confidence only breaks ties within a layer. _(confidence 1.00)_

## References

- docs/framework.md is the overall model: layers, atoms, lifecycle, arbitration, retrieval. Read after the target architecture doc. _(confidence 1.00)_
- design/host-interface.md is the authoritative specification of the 8-interface Host contract every adapter must satisfy. _(confidence 1.00)_
- If RAG brings knowledge into an agent, LAG governs knowledge across agents. One-sentence position statement; lives in README. _(confidence 1.00)_
- design/target-architecture.md is the north-star diagram with gap analysis and leverage-ordered roadmap. Read this first when scoping a new phase. _(confidence 1.00)_
<!-- lag:canon-end -->
