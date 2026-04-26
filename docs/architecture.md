# Architecture

LAG is a substrate, not a prescription. The governance primitives are deterministic; the autonomy dial is data, not code; outward-acting work happens in Actors that wear governed identities.

## Atoms

Every stored unit is an atom with: id, layer (L0..L3), type, content, principal, scope, confidence, provenance chain, and lifecycle state. Nothing gets deleted; superseded atoms keep their `superseded_by` pointer so history is reconstructible. (`arch-atomstore-source-of-truth`)

## Layers

- **L0 raw**: session imports.
- **L1 extracted**: claims pulled from L0.
- **L2 curated**: consensus across principals.
- **L3 canon**: human-gated, renders into `CLAUDE.md` targets.

Promotion creates a new atom at the target layer with `provenance.kind='canon-promoted'` and marks the source superseded.

## Principals and signed_by

Every atom records a `principal_id`; principals themselves form a `signed_by` hierarchy from a root key downward. That hierarchy depth feeds source-rank during arbitration. Compromise of a principal cascades taint across every derived atom across `provenance.derived_from` chains. (`arch-principal-hierarchy-signed-by`)

Per-actor bot identities project the principal hierarchy onto GitHub: each Actor role gets its own GitHub App, its own credentials, its own permission set, its own revocation boundary. (`arch-bot-identity-per-actor`)

## Host: the governance boundary

A `Host` is an 8-interface contract: `AtomStore`, `CanonStore`, `LLM`, `Notifier`, `Scheduler`, `Auditor`, `PrincipalStore`, `Clock`. Three implementations (`memory`, `file`, `bridge`) all satisfy the same contract; conformance is enforced at test time. (`arch-host-interface-boundary`)

## Actors: the external-effect boundary

An `Actor` is a governed autonomous loop: observe, classify, propose, apply, reflect (MAPE-K lineage). `runActor` drives it with kill-switch, budget, convergence guard, and per-action policy gating via `checkToolPolicy`.

External systems (GitHub, CI, deploy targets) are `ActorAdapter`s, deliberately separate from `Host`: governance state stays inside the Host boundary; outward effects ride a different seam.

## Inbox: actor-to-actor coordination

Actor messages are atoms. They inherit arbitration, taint propagation, decay, and the policy layer for free; coordination is not a second substrate. The inbox primitive (`actor-message`) adds a write-time rate limiter, circuit breaker, pickup handler, sub-actor registry, and a dispatch loop. (`arch-actor-message-inbox-primitive`)

## What this enables

- Autonomous orgs of agents with persistent roles, shared memory, and per-role audit.
- Cross-session memory that survives reversals.
- Multi-agent coordination that resolves at write time, not nightly.
- Operator incident response via cascading taint.

## Where to dig in

- [`docs/loops/agentic-actor-loop.md`](loops/agentic-actor-loop.md): the agentic actor loop trilogy.
- [`docs/integration.md`](integration.md): plug-in points, including the `cr-precheck` pre-push capability.
- [`docs/canon.md`](canon.md): the L3 atom catalogue.
- `design/target-architecture.md`: north-star and gap analysis.
- `DECISIONS.md`: living architectural log.
