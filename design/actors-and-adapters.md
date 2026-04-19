# Actors and Adapters

**Status**: design proposal, pending review
**Author**: Claude + Stephen (2026-04-19)
**Phase**: 53-pre (resolution doc that must land before 53a code)

---

## Why this doc exists

Phase 53 introduces LAG's first **outward-acting agent**: a pr-landing loop
that observes CodeRabbit reviews on a GitHub PR, classifies comments, and
takes actions (commits, pushes, replies) against GitHub. That shape -- an
autonomous loop that touches external systems -- is a new class of thing in
LAG. It is materially different from `LoopRunner`, which is inward-facing
(decay, TTL, canon application over our own atom store).

Before writing `src/actors/`, we owe ourselves a resolution of two tensions
that naive coding will compound:

1. **D1 (Host is the sole boundary)** says framework logic never reaches
   around the 8-sub-interface `Host` contract. But an outward actor needs
   the GitHub API, CI APIs, deploy targets -- adapters that do not fit into
   any of the current Host sub-interfaces.
2. **`LoopRunner` and a future `Actor` are two names for the same shape**
   at different orientations (inward vs outward). Shipping both without
   naming the relationship produces two parallel loop vocabularies.

This doc resolves both.

---

## Vocabulary (fixed)

| Term | Meaning |
| ---- | ------- |
| **Principal** | Identity + authority. A canon atom with `signed_by` chain. Existing primitive. |
| **Actor** | Mechanism. A named loop shape: `observe -> classify -> propose -> apply -> reflect`. New primitive. |
| **LLM** | Judgment engine. Optional dependency of an Actor; plugged via `Host.llm`. Existing. |
| **Agent** | Colloquial name for a *running* `Principal + Actor (+ LLM)` assembly. Not a framework primitive. |
| **ActorAdapter** | Actor-scoped external-system adapter (GitHub, CI, deploys, docs). Not part of `Host`. New primitive. |
| **Role** | Colloquial: `Principal x Actor`. What the org reads as "the CTO's pr-landing bot." |

The framework ships Principal, Actor, LLM, ActorAdapter. It does **not**
ship any particular Agent, Role, or Principal identity. Those live in
canon atoms, skills, and `examples/`.

---

## The core tension: D1 and outward adapters

**D1 excerpt** (paraphrased): "The `Host` interface is the sole boundary
between framework logic and any concrete implementation. Eight
sub-interfaces: AtomStore, CanonStore, LLM, Notifier, Scheduler, Auditor,
PrincipalStore, Clock. LAG logic never reaches around this boundary."

D1 was written when every concrete dependency LAG needed fit into one of
those eight interfaces. That is no longer true once actors start calling
out to systems like GitHub, CircleCI, Vercel, Fly, Grafana, Datadog, or
arbitrary webhooks. We have four options.

### Option A: Widen `Host` with a 9th sub-interface

Add `Host.externalSystems: ExternalSystemRegistry` that resolves named
adapters at runtime.

* **Pro**: D1 literally holds; Host remains the sole boundary.
* **Con**: Host must be constructable knowing every external system the
  consumer's actors will ever touch. That scales poorly -- a 50-actor org
  has to enumerate every integration at Host construction time. Host
  becomes a god-object registry.
* **Con**: The typing is cursed. A generic `ExternalSystemRegistry`
  either loses type safety at the lookup site or requires each consumer
  to augment the Host type.

Rejected. Host is a **governance** boundary; stuffing arbitrary external
systems into it dilutes the abstraction.

### Option B: Actors construct adapters directly (reach around Host)

`PrLandingActor` instantiates `CodeRabbitAdapter` in its constructor
directly, bypassing Host entirely.

* **Pro**: Simple. Each Actor is self-contained.
* **Con**: Violates D1 in letter and spirit. Framework code reaches
  around Host. Adapters cannot be faked for tests via a single Host stub;
  every test of an Actor must mock adapters separately.
* **Con**: No canonical place to register / discover / dispose adapters
  across an org running many actors.

Rejected.

### Option C: Host gains a typed, extensible `extensions` registry

Similar to A but type-safe via module augmentation: adapters register
themselves under a symbol and the registry exposes `get<T>(symbol)`.

* **Pro**: Extensible without bloating Host sub-interfaces.
* **Con**: TypeScript module augmentation is powerful but opaque;
  documentation and discoverability suffer.
* **Con**: Still funnels non-governance concerns through `Host`, which
  muddles the "Host is the governance boundary" story.

Rejected as primary model, kept as a fallback if D is too ambitious.

### Option D (chosen): Narrow D1's scope; introduce `ActorAdapter` as a deliberate second seam

**Decision**: `Host` is the sole boundary **for governance primitives**
(atoms, canon, LLM, notifications, scheduling, audit, principals, time).
`ActorAdapter` is a **second, actor-scoped boundary** for external
systems that actors touch.

The two boundaries do not cross. An Actor consumes both: a `Host` for
governance and its declared `ActorAdapter`s for external effects. The
framework's `runActor` driver **gates every external action through
`checkToolPolicy` before the adapter executes** and **audits the
outcome through `Host.auditor` after**. The contract: policy is the
pre-action gate; audit is the post-action record. Both are load-bearing
and their order is observable per the run-order section below.

* **Pro**: D1's intent (no sneaking past governance) is preserved
  *exactly*. We only narrow its **scope**, explicitly and with rationale.
* **Pro**: Host stays a focused 8-interface contract forever. Adding
  GitHub / CI / deploy support never touches `Host`.
* **Pro**: Actors declare their adapter dependencies at the type level,
  so a consumer reading `PrLandingActor` sees what it reaches for without
  spelunking through a global registry.
* **Pro**: Test story is clean -- stub the `Host` for governance, stub
  the adapters for external effects, compose both.
* **Con**: Two boundaries to learn instead of one. Mitigated by making
  the line crisp and documenting it here.
* **Con**: D1 gets amended. That is *fine*: D0 already says decisions
  are precedent, not law, and every entry has a "what breaks if we
  revisit" field for exactly this.

---

## Shape

### `Actor` interface (skeleton, types elided for clarity)

```ts
interface Actor<Obs, Act, Out, Adapters extends ActorAdapters> {
  readonly name: string;
  readonly version: string;
  readonly requiredAdapters: AdapterSpec<Adapters>;
  observe(ctx: ActorContext<Adapters>): Promise<Obs>;
  classify(obs: Obs, ctx: ActorContext<Adapters>): Promise<Classified<Obs>>;
  propose(obs: Classified<Obs>, ctx: ActorContext<Adapters>): Promise<Act[]>;
  apply(action: Act, ctx: ActorContext<Adapters>): Promise<Out>;
  reflect(outcome: Out, ctx: ActorContext<Adapters>): Promise<Reflection>;
}

interface ActorAdapter {
  readonly name: string;
  readonly version: string;
  dispose?(): Promise<void>;
}

interface ActorContext<Adapters extends ActorAdapters> {
  readonly host: Host;
  readonly principal: Principal;
  readonly adapters: Adapters;
  readonly budget: ActorBudget;
  readonly killSwitch: () => boolean;
  readonly audit: (event: ActorAuditEvent) => Promise<void>;
}

interface ActorBudget {
  readonly maxIterations: number;
  readonly deadline?: Time;
  readonly maxTokens?: number;
}
```

### `runActor` driver (contract, not implementation)

Each iteration, in order. The kill-switch is checked at iteration start
AND before each `apply` so a halt request during a multi-action iteration
is honored at the earliest safe point (between actions, never mid-
adapter-call):

1. `killSwitch()` -> if true, halt with status `halted`.
2. Budget check (deadline, iteration cap). If exhausted, halt.
3. `observe(ctx)`. Audit observation to `host.auditor`.
4. `classify(obs, ctx)`. Audit classification.
5. Convergence guard: if `classify` returns the same class as the
   prior iteration AND the prior iteration made no progress, emit an
   escalation signal and halt with `convergence-loop`.
6. `propose(classified, ctx)`. Audit proposal.
7. For each proposed action, in order:
   a. `killSwitch()` -> if true, halt. No more actions in this
      iteration; already-applied actions stand.
   b. `checkToolPolicy(host, action)` (52a). Audit the decision.
      - `deny`: skip; escalate recorded.
      - `escalate`: skip; escalate recorded; iteration halts after
        remaining proposals are gated (writes do not proceed).
      - `allow`: `apply(action, ctx)`. Audit the outcome.
8. `reflect(outcomes, classified, ctx)`. Audit reflection.
9. If `reflect` returns `done`, halt with status `converged`.

Contract: policy is the **pre-action** gate; audit is the
**post-action** record. Every phase produces an audit event; halt
always produces a final `halt` audit event carrying `haltReason` and
`escalations`.

`runActor` returns an `ActorReport`: statuses, audit refs, escalation
refs, final reflections.

### `ActorAdapter` composition pattern

Adapters are plain interfaces + constructors. A consumer composes them
at bootstrap time and passes them to the actor:

```ts
const host = createMemoryHost();
const github = new GhCliAdapter({ repo: 'owner/repo' });
const coderabbit = new CodeRabbitCommentAdapter({ github });
const prActor = new PrLandingActor();
const report = await runActor(prActor, {
  host,
  principal: prLandingPrincipal,
  adapters: { github, coderabbit },
  budget: { maxIterations: 8 },
  killSwitch: () => existsSync('.lag/STOP'),
  audit: (ev) => host.auditor.write(ev),
});
```

This mirrors how the current framework composes `Host` from adapters
(`createMemoryHost`, `createFileHost`) -- small constructors that a
consumer wires up explicitly. No magic registry.

---

## What this preserves vs changes about D1

**Preserved**:
- Framework logic never reaches around governance concerns (atoms,
  canon, LLM, notifications, principals, audit, clock, scheduling).
- `Host` stays an 8-sub-interface contract that any adapter conformance
  test can target. Host purity is the anchor.

**Changed (deliberately)**:
- D1's scope is now explicitly **governance**. Outward-facing external
  systems are a second, actor-scoped boundary.
- A new DECISIONS entry (**D17**) documents this narrowing with full
  alternatives-considered and what-breaks context, per D0's discipline.

**What breaks if we revisit**:
- If we unify everything under Host again, actors lose their self-declared
  adapter surface and tests get harder to compose.
- If we drop the second boundary entirely (actors free to instantiate
  anything), we lose the gate point where `checkToolPolicy` and audit
  sit, which is the whole reason the governance substrate exists.

---

## Relationship to `LoopRunner`

`LoopRunner` runs a deterministic inward loop: decay confidence, expire
TTL, apply canon. It *is* an Actor -- the first inward actor we built,
before we had the abstraction. We will **not** retire `LoopRunner` on
the same release as shipping `Actor`; two converging migrations in one
release is dangerous. Plan:

- **53a**: Ship `Actor` + `runActor` + `ActorAdapter`, one outward Actor
  (`PrLandingActor`) and its adapters. `LoopRunner` untouched.
- **V2 (post 53b)**: Reframe `LoopRunner` as a canonical `InwardActor`
  implementation; keep the current class as a thin adapter over the new
  primitive so existing callers keep working; deprecate over one release.

This is documented here, not in code, to set expectations for contributors.

---

## Open questions flagged for follow-up

- **Adapter lifecycle**: `dispose` is optional but recommended. Do we
  need an opinionated `AdapterLifecycleManager` or is "caller manages
  construction + disposal" enough? Current read: enough.
- **Multi-adapter transactions**: if an Actor's `apply` touches two
  external systems and one fails, is there a rollback contract?
  Initial answer: no, actors are best-effort; audit captures partial
  outcomes. Revisit when a real actor demands transactional semantics.
- **Adapter capability policy**: can `checkToolPolicy` key on adapter
  capabilities (e.g., "github.push", "github.merge") rather than only
  tool names? Probably yes, as a second phase. Flagged for 52b scoping.
