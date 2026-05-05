# Resume-By-Default Extension to Non-PrFix Actor Handoffs

> **Status:** proposed; needs operator approval before implementation.
>
> **Predecessor:** `docs/superpowers/specs/2026-04-25-resume-author-agent-loop-adapter-design.md` (PR #171). This spec extends the resume-by-default substrate from PrFixActor to the broader actor surface. Where this spec defers to PR #171's design (threat model, data flow, capture/rehydrate ladder, default-deny construction guards), it cites the section explicitly rather than restating it.

## 0. Future-proofing checklist (per `dev-design-decisions-3-month-review`)

This design must survive a 3-month-later review with 10x more actors, 10x more canon, and an order of magnitude more external integrations. Each canonical concern is addressed below; the 3-month posture is "the wrapper is generic, per-actor strategies are policy-atom-driven, and the indie-floor solo developer never sees a knob."

| Canon | How this design satisfies it |
|---|---|
| `dev-design-decisions-3-month-review` | The same `ResumeAuthorAgentLoopAdapter` wrapper covers every actor. New actors register a per-principal candidate-walk + opt-in policy atom; no fork in the substrate or in the wrapper. See sections 3 + 5. |
| `dev-indie-floor-org-ceiling` | Indie default is opt-in: `pol-resume-strategy-<principal-id>` ships absent for every actor except `pr-fix-actor` (where PR #171 already wires it). A solo developer running `run-cto-actor.mjs` on a typo-fix gets fresh-spawn and never surprise-restores stale context. Org-ceiling deployments flip the dial via canon edit per actor. See section 5. |
| `dev-substrate-not-prescription` | The resume-strategy registry is a pluggable substrate primitive (a `Map<PrincipalId, ResumeStrategyDescriptor>`); concrete walk functions and capture closures live in `examples/agent-loops/resume-author/walks/` per actor. The substrate provides the seam; specific actor knowledge stays in examples + canon policy. See section 3. |
| `dev-easy-vs-pluggability-tradeoff` | The "easy" path would be ship a `ResumeCtoActorAdapter`, then a `ResumeCodeAuthorAdapter`, then a `ResumeAuditorAdapter`, copy-pasting the wrapper N times. Rejected: per `dev-extract-helpers-at-n-2`, this is exactly the duplication-to-extract pattern PR #171 anticipated. The wrapper is already actor-neutral; the missing piece is the per-actor walk-fn registry. See section 3 + 8. |
| `dev-no-org-shape-in-src` | The registry primitive lives in `examples/agent-loops/resume-author/registry.ts` next to the PR #171 wrapper; per-actor walk-fns and policy-atom keys live in `examples/agent-loops/resume-author/walks/<actor-id>/` + `.lag/atoms/`. No actor names enter `src/`. The substrate primitives in `src/` (the `AgentLoopAdapter` interface, the `SessionResumeStrategy` interface, and the `CandidateSession` shape from PR #171) remain unchanged. See section 7. |
| `inv-conflict-detection-at-write-time` | Capture-side `onSessionPersist` continues to fire synchronously on session-end before the session atom is finalized; broader actor coverage does not change this. |
| `inv-l3-requires-human-default` | No L3 promotion; resume capture writes session atoms at L0 (unchanged from PR #171). |
| `inv-design-kill-switch-first` | Wrapper inherits the substrate's existing kill-switch behavior on every actor it wraps. Both resume + fallback paths abort cooperatively via `AgentLoopInput.signal` (PR #171 §0). |
| `dev-coderabbit-cli-pre-push` | This spec is docs-only; the cr-precheck pre-push gate applies once any of the 4 implementation PRs lands. See section 8. |
| `dev-implementation-canon-audit-loop` | Each implementation PR (PR1-PR4 in section 8) dispatches a canon-compliance auditor sub-agent per substantive task. Per-actor wrappers in PR2 must each clear the audit. |
| `dev-extreme-rigor-and-research` | Section 1 inventories the actor surface; section 4 enumerates fresh-spawn exceptions; section 7 maps every new attack surface to PR #171's §5 threat model. Alternatives rejected (section 10) capture the two strategy variants we considered and discarded. |
| `dev-flag-structural-concerns-proactively` | Section 9 surfaces three structural concerns: cross-actor work-item leakage, registry-as-singleton, and policy-atom drift across actor renames. Each is articulated explicitly with the trade-off named. |

## 1. Purpose + actor inventory

PR #171 shipped `ResumeAuthorAgentLoopAdapter` covering PrFixActor only. The wrapper is actor-neutral by design (the `assembleCandidates` callback is the per-actor knob), but the wiring lives in `scripts/run-pr-fix.mjs` and only that script. Every other actor handoff in the codebase still fresh-spawns: when `run-cto-actor.mjs` is invoked twice in a row on the same operator-intent, the second invocation re-derives the codebase reads, re-walks the canon, and may produce a divergent plan from the first. Operator direction 2026-04-26 (memory `project_resume_by_default_across_actor_handoffs`):

> "every same-actor re-invocation on the same work-item must resume prior session; fresh-spawn is the exception (new project / unrecoverable / explicit reset)."

The remedy: extend the resume-by-default substrate to every actor that has a recoverable per-work-item session. Indie-floor default stays opt-in (the solo developer sees no behavior change without flipping a per-actor canon policy); org-ceiling deployments flip the dial per actor.

### 1.1 Actor inventory

The following actors handoff today (i.e., the same actor instance is re-invoked across iterations on the same work-item) and would benefit from resume-by-default:

| Actor (principal-id) | Work-item key | Re-invocation pattern | Resume-by-default benefit |
|---|---|---|---|
| `pr-fix-actor` | `(pr_owner, pr_repo, pr_number)` | observe -> classify -> propose -> apply -> reflect, repeated each fix-cycle until CR+CI clean | **already shipped** (PR #171). |
| `cto-actor` | `intent_atom_id` (the seed operator-intent driving this planning run) | run-cto-actor.mjs invoked once per operator-intent, but in practice operators re-dispatch on the same intent after a CR round-trip on the resulting code-author PR | High: the planner's accumulated reads of canon + atom-store cost ~40-80 turns to re-derive; a resumed session inherits the prior plan-state context. |
| `code-author` | `plan_atom_id` (the approved Plan atom that authorizes this draft) | dispatched once per approved plan; re-invocation happens on draft-PR re-roll if the first draft fails CR-precheck or schema validation | Medium: the drafter's fileContents reads are deterministic from the plan, so the re-derive cost is small; the win is preserving the drafter's first-draft trade-off reasoning so a re-roll does not silently flip the implementation shape. |
| `pipeline-stage` actors (brainstorm-stage, spec-stage, plan-stage, review-stage, dispatch-stage) | `pipeline_atom_id` + `stage_name` | per-stage invocation inside `PipelineRunner`; pause/resume via `pipeline-resume` atoms (see `src/runtime/planning-pipeline/runner.ts`) | High for the long stages (brainstorm, spec, plan): each stage's accumulated reads are stage-specific and re-deriving on a `pipeline-resume` is exactly the case PR #171's pattern was designed for. Low for the short stages (review-stage walks audits; dispatch-stage hands off). |
| `auditor-actor` | `(audited_atom_id, audit_kind)` (e.g. an audit walk for a plan atom against canon) | re-invoked when an audit-finding is contested or a re-audit is requested | Medium: auditors are typically read-heavy and benefit from preserving the prior walk's reasoning, but most audits are single-shot. |
| `pr-landing-actor` | `(pr_owner, pr_repo, pr_number)` | observe-only loop watching CR + CI on a code-author PR; re-invoked each poll cycle | Low: the PR-landing actor is observation-only and has minimal context to preserve. **Excluded from this spec.** Adding resume here is overhead without a context-preservation win. |
| `pr-review-actor` | `(pr_owner, pr_repo, pr_number)` | per-review-cycle invocation responding to CR threads | Low: similar to pr-landing; thread responses are short-context. **Excluded from this spec.** |

### 1.2 Excluded actors

`pr-landing-actor` and `pr-review-actor` are excluded. Their per-invocation context is small (observation-only or single-thread response) and the resume substrate's per-call overhead (candidate walk + strategy iteration + atom patch) is plausibly larger than the re-derive cost. If a future work-load shows otherwise (e.g., a long pr-review thread that requires multi-turn reasoning), they can be added by registering a per-actor walk-fn and policy atom, with no substrate change needed.

### 1.3 Out-of-scope

- Cross-actor handoffs (e.g., cto-actor's plan -> code-author's draft) are NOT resumed. The session continuity contract is per-actor; a code-author run does not resume the cto-actor session that produced its plan. A future spec may explore "actor-chain resume" where a code-author run inherits cto-actor's reasoning, but that is a different shape (cross-principal context transfer) and not addressed here.
- Multi-tenant orgs running parallel iterations of the same actor on the same work-item (e.g., two code-author runs against one plan to produce competing drafts) are NOT addressed. Same-work-item parallelism opens a session-locking concern (PR #171 §6.6 documents this for PrFixActor); broader coverage MUST inherit the same sequential-per-work-item constraint until a separate locking design lands.

## 2. Architectural seam

The substrate change is a per-principal **resume-strategy registry**: a `Map<PrincipalId, ResumeStrategyDescriptor>` that the runner script consults at construction time to decide whether to wrap the underlying `AgentLoopAdapter` with `ResumeAuthorAgentLoopAdapter` and which `assembleCandidates` callback to use. The wrapper itself (PR #171 §3.3) is unchanged; the new piece is the registry indirection that lets each actor's runner script ask "is resume enabled for my principal? if so, what's my walk-fn?" without each runner re-implementing the question.

### 2.1 What ships across the implementation PRs

Per the implementation roadmap in section 8, the substrate work is staged across 4 PRs. Each PR is independent off main and gates the next.

1. **PR1 (substrate generalization):** `ResumeStrategyRegistry` primitive lives in `examples/agent-loops/resume-author/registry.ts`. A runner script consults the registry at construction time. No new src/ types beyond what PR #171 already shipped (the wrapper, the `SessionResumeStrategy` interface, the candidate session shape).
2. **PR2 (per-actor wrappers + walks):** Per-actor walk-fns for `cto-actor` and `code-author` (the highest-traffic non-PrFix actors). Each ships in `examples/agent-loops/resume-author/walks/<actor-id>/walk.ts` next to the existing `walk-author-sessions.ts` (now renamed to `walks/pr-fix/walk.ts` for consistency).
3. **PR3 (canon policy atoms):** `pol-resume-strategy-<principal-id>` policy atoms. Indie-floor default is absent (resume off); org-ceiling deployments add the atom per actor to enable. The policy atom carries the strategy ladder, the maxStaleHours override, and the work-item identification key for that actor.
4. **PR4 (audit + dashboard surface):** A new Console view (`/resume`) projecting the `metadata.agent_session.extra.resume_strategy_used` and `extra.resumed_from_atom_id` fields across all actors so operators see a resume-vs-fresh-spawn ratio per actor over time.

### 2.2 What does NOT ship in any of these PRs

- No actor change. Every actor sees the same `AgentLoopAdapter` contract.
- No new substrate atom types. The `extra` slot on `AgentSessionMeta` is the documented extension point and remains the storage for resume-correlation fields.
- No locking primitive. Same-work-item concurrent runs are the operator's responsibility; section 9 documents the trade-off explicitly.
- No cross-actor session transfer. Same-actor resume only.

## 3. Resume-strategy registry

### 3.1 The primitive

```ts
// examples/agent-loops/resume-author/registry.ts

export interface ResumeStrategyDescriptor {
  readonly principalId: PrincipalId;
  /** Strategies tried in declaration order; first non-null wins. */
  readonly strategies: ReadonlyArray<SessionResumeStrategy>;
  /** Per-actor candidate walk: closes over actor-specific work-item context. */
  readonly assembleCandidates: (
    input: AgentLoopInput,
    workItemKey: WorkItemKey,
  ) => Promise<ReadonlyArray<CandidateSession>>;
  /** Per-actor work-item identification: how to derive the key from input. */
  readonly identifyWorkItem: (input: AgentLoopInput) => WorkItemKey | null;
  /** Optional per-actor max-stale override; default 8h matches PR #171. */
  readonly maxStaleHours?: number;
}

export type WorkItemKey =
  | { readonly kind: 'pr'; readonly owner: string; readonly repo: string; readonly number: number }
  | { readonly kind: 'intent'; readonly intentAtomId: AtomId }
  | { readonly kind: 'plan'; readonly planAtomId: AtomId }
  | { readonly kind: 'pipeline-stage'; readonly pipelineId: AtomId; readonly stageName: string }
  | { readonly kind: 'audit'; readonly auditedAtomId: AtomId; readonly auditKind: string }
  | { readonly kind: 'custom'; readonly principalId: PrincipalId; readonly key: string };

export class ResumeStrategyRegistry {
  private readonly map = new Map<PrincipalId, ResumeStrategyDescriptor>();
  register(descriptor: ResumeStrategyDescriptor): void;
  /** Returns undefined if no descriptor is registered for the principal. */
  get(principalId: PrincipalId): ResumeStrategyDescriptor | undefined;
  /**
   * Returns an adapter that, on each `acquire(input)`, decides whether to
   * resume or fresh-spawn based on the registered descriptor, the policy
   * atom `pol-resume-strategy-<principal-id>`, and any unconsumed
   * `resume-reset-<principal-id>-<work-item-key>` atom matching this
   * invocation's `AgentLoopInput`. If no descriptor is registered OR the
   * policy atom resolves to disabled, returns the fallback unchanged at
   * construction time so there is no per-invocation overhead in the
   * indie-floor default case.
   *
   * When wrapping IS active, reset evaluation runs inside the returned
   * adapter's `acquire` path because the reset atom's key is derived from
   * `AgentLoopInput` via the descriptor's `identifyWorkItem` callback,
   * which is only callable per-invocation.
   */
  wrapIfEnabled(
    fallback: AgentLoopAdapter,
    principalId: PrincipalId,
    host: Host,
  ): Promise<AgentLoopAdapter>;
}
```

The registry is a **runner-side** construct: each runner script (`run-cto-actor.mjs`, `run-code-author.mjs`, `run-pr-fix.mjs`, etc.) constructs the registry, registers its descriptor, and calls `wrapIfEnabled` to produce the adapter it passes to the actor. The registry never reaches into the actor's apply path; the actor sees an opaque `AgentLoopAdapter` interface as before.

Construction-time work in `wrapIfEnabled`: descriptor lookup, policy-atom resolution, fallback short-circuit when disabled. Per-invocation work inside the returned adapter: `identifyWorkItem(input)` to derive the work-item key, AtomStore lookup for an unconsumed `resume-reset-<principal-id>-<work-item-key>` atom, candidate-walk + strategy iteration on no-reset, fresh-spawn delegation on reset-found. This split keeps the indie-floor zero-overhead property (no work-item key derivation when policy is off) while letting reset enforcement use the per-invocation input.

### 3.2 Why a registry vs per-actor wrappers

**Rejected alternative: per-actor wrappers.** We considered shipping `ResumeCtoActorAdapter`, `ResumeCodeAuthorAdapter`, etc. as separate wrapper classes. Each would extend or compose the PR #171 wrapper with actor-specific assembly logic.

This pattern is the duplication trap `dev-extract-helpers-at-n-2` flags: with PrFixActor's wrapper at N=1 and a CTO wrapper at N=2, we should extract the shared shape now rather than wait for the third copy. The PR #171 wrapper IS the shared shape; the only per-actor variation is the walk-fn + the work-item key. A registry-of-walk-fns is the cleanest extraction.

A second concern is testability: with N per-actor wrappers, each gains its own integration test surface. With one wrapper and N walk-fns, the wrapper's tests (PR #171 already has them) cover the orchestration logic and each walk-fn gets a small unit test for "given this atom chain, return these candidates." The test-surface delta is much smaller.

### 3.3 Wrapper unchanged from PR #171

`ResumeAuthorAgentLoopAdapter` (`examples/agent-loops/resume-author/loop.ts`) is unchanged. The wrapper already accepts an `assembleCandidates` callback per `ResumeAuthorAdapterOptions.assembleCandidates`; the new piece is that the callback now closes over a per-actor walk-fn from the registry rather than being hand-written in the runner script. From the wrapper's perspective, the contract is identical.

## 4. Same-work-item identification

Different actors have different work-item keys. The registry's `identifyWorkItem` callback derives the key from the `AgentLoopInput`; the candidate walk uses the key to filter sessions to the same work-item.

### 4.1 Per-actor work-item keys

| Actor | Work-item key | Source field |
|---|---|---|
| `pr-fix-actor` | `(pr_owner, pr_repo, pr_number)` | already in observation atom metadata; PR #171's `walkAuthorSessions` reads it. |
| `cto-actor` | `intent_atom_id` | `AgentTask.planAtomId`'s `provenance.derived_from[0]` chain back to the seed operator-intent atom. |
| `code-author` | `plan_atom_id` | `AgentTask.planAtomId` directly. |
| pipeline-stage actors | `(pipeline_atom_id, stage_name)` | `AgentTask.planAtomId` is the pipeline atom; stage-name lives in the runner's per-invocation context. |
| `auditor-actor` | `(audited_atom_id, audit_kind)` | `AgentTask` extension OR a runner-side closure capturing the audit context. |

### 4.2 Carrying the work-item key into the walk

The registry's `assembleCandidates` callback receives the derived work-item key and walks the atom chain that's relevant for that key. For PR-fix, the walk is `walkAuthorSessions` (PR #171). For CTO-actor, the walk follows `provenance.derived_from` from the current intent atom forward to find prior planning sessions seeded by the same intent. For code-author, the walk reads agent-session atoms whose `metadata.agent_session.task_plan_atom_id === planAtomId` (substrate already records this; PR #171's `extra.resumable_session_id` is the resume-token slot).

### 4.3 Substrate field for plan-id correlation

`AgentSessionMeta` already carries `task_plan_atom_id` (verified during research; see PR #166's substrate types). No new field is needed for code-author / cto-actor walks. The pipeline-stage walks need the pipeline atom's stage-history record (which the runner already writes); no substrate change.

If a future actor lacks an existing correlation field (e.g., an auditor that has no current `audited_atom_id` slot in the session atom), the resolution per `dev-substrate-not-prescription` is to add a single optional field to `AgentSessionMeta.extra` (the documented extension slot) rather than introduce a new top-level field. Walks then read from `extra` the same way `walkAuthorSessions` reads `dispatched_session_atom_id`.

## 5. Per-actor canon policy atoms

### 5.1 Policy-atom shape

```text
type: pol-resume-strategy
id: pol-resume-strategy-<principal-id>
metadata.policy.principal_id: <principal-id>
metadata.policy.enabled: boolean (default false)
metadata.policy.strategies: ReadonlyArray<{ name: string; options?: object }>
metadata.policy.max_stale_hours: number (default 8)
metadata.policy.fresh_spawn_exceptions: ReadonlyArray<FreshSpawnExceptionKind>
```

`FreshSpawnExceptionKind` is the substrate-defined ENUM for fresh-spawn fall-back rules (see section 6 below); the policy lists which exceptions opt-in for this actor.

### 5.2 Indie-floor default: absent

The policy atom ships ABSENT for every principal except `pr-fix-actor` (where PR #171 hard-codes the wiring in `run-pr-fix.mjs`). A solo developer running `run-cto-actor.mjs` for the first time gets fresh-spawn (today's behavior) and never surprise-restores stale context from a session they may not even remember.

### 5.3 Org-ceiling: opt-in per actor

An org-ceiling deployment that has decided "every CTO planning re-invocation on the same intent should resume" writes a single canon atom:

```text
{
  type: 'pol-resume-strategy',
  id: 'pol-resume-strategy-cto-actor',
  metadata: {
    policy: {
      principal_id: 'cto-actor',
      enabled: true,
      strategies: [{ name: 'same-machine-cli', options: { maxStaleHours: 12 } }],
      max_stale_hours: 12,
      fresh_spawn_exceptions: ['budget-exhausted', 'context-overflow', 'stale-window-exceeded', 'operator-reset', 'workspace-unrecoverable', 'model-version-mismatch'],
    },
    layer: 3,
    confidence: 1.0,
    // ...
  },
}
```

Adding the atom turns resume on for that principal across every runner script that consults the registry; removing it turns it off. This is the canonical "raise the dial via canon edit" pattern the dial-future-proofing canon (`dev-apex-tunable-trade-off-dials-future-seam`) anticipates.

### 5.4 Why per-actor opt-in vs a single global toggle

**Rejected:** a single `pol-resume-strategy-global.enabled = true` atom that turns resume on for all registered actors. Considered, then rejected because the failure modes differ across actors:

- A CTO-actor resume-on-stale-context is low-risk: the planner re-grounds against canon at every observe phase, so even a stale resume gets corrected.
- A code-author resume-on-stale-context is higher-risk: the drafter operates on `fileContents` snapshots; a resume that picks up a stale read gets baked into the diff.
- A pipeline-stage resume is mid-risk: each stage runs once per pipeline so the same-work-item concept is "same pipeline-id + same stage-name" which is a tighter scope than CTO-actor.

A single global toggle would force the operator to either accept the highest-risk actor's posture for everyone, or build a per-actor override mechanism on top, which is what the per-actor opt-in already is, with one less indirection. The simpler shape is per-actor opt-in.

## 6. Fresh-spawn exceptions

The PR #171 wrapper falls back to fresh-spawn on three implicit conditions:
1. No strategy resolves (all return null OR throw).
2. The resume invocation returns a non-`completed` result.
3. `preparation` throws.

For broader coverage, the spec generalizes these into a typed ENUM the policy atom can opt-in/opt-out of. Per `dev-apex-tunable-trade-off-dials-future-seam`, the dial values are a substrate-defined ENUM, never a free-form string.

### 6.1 The ENUM

```ts
export type FreshSpawnExceptionKind =
  | 'budget-exhausted'           // prior session hit max_usd / max_turns / max_wall_clock_ms
  | 'context-overflow'           // prior session accumulated context exceeds 80% of model window
  | 'stale-window-exceeded'      // prior session.started_at older than max_stale_hours
  | 'operator-reset'             // operator wrote a `resume-reset-<principal-id>-<work-item-key>` atom
  | 'workspace-unrecoverable'    // workspace dir vanished; CLI cache file missing
  | 'model-version-mismatch'     // prior session used a different model_id than current invocation
  | 'principal-mismatch'         // prior session's principal != current principal (paranoid guard)
  | 'taint-detected';            // prior session atom carries `taint !== 'clean'`
```

Each value is a finite, documented choice. A new exception kind is a canon edit (a new ENUM value defined in the substrate types module + tests + docs); not a free-form configuration knob.

### 6.2 Indie-floor defaults

For `pr-fix-actor` (PR #171), the wrapper's three implicit conditions roughly correspond to `stale-window-exceeded`, `workspace-unrecoverable`, and the implicit "any non-completed result." The indie-floor default for any new actor's policy atom should include AT LEAST `budget-exhausted`, `stale-window-exceeded`, `workspace-unrecoverable`, and `operator-reset`. A deployment that wants to be aggressive about fresh-spawn ladders all eight; a deployment that wants minimal fresh-spawn ladders the bottom four.

### 6.3 Operator-reset escape hatch

`operator-reset` is the substrate's "I changed my mind, throw away the prior session" signal. The operator writes a `resume-reset-<principal-id>-<work-item-key>` atom (e.g. `resume-reset-cto-actor-intent-abc123`); the wrapped adapter's per-invocation `acquire` path checks for the reset atom and skips resume on a hit. The reset atom has its own L0 layer and is consumed-and-archived after one use (the wrapper writes a `resume-reset-consumed` atom referencing it so a re-run does not silently re-reset).

Without this escape hatch, an operator who wants to "start fresh" on a stuck work-item has no canonical way to opt out; their only path is to flip the canon policy atom off, run, then flip it back on, which is heavy and easy to forget. Operator-reset is the lightweight escape.

### 6.4 Substrate atom: `resume-reset`

```text
type: resume-reset
id: resume-reset-<principal-id>-<work-item-key-encoded>
metadata.reset.principal_id: PrincipalId
metadata.reset.work_item_key: WorkItemKey  // structured, see section 4.1
metadata.reset.reason: string (operator-supplied free text)
provenance.principal: <operator-principal-id>
```

The reset check runs at invocation time inside the returned adapter's `acquire(input)` path, NOT at `wrapIfEnabled` construction time. The wrapped adapter calls `descriptor.identifyWorkItem(input)` to derive the per-invocation key, then queries the AtomStore for any unconsumed `resume-reset-<principal-id>-<work-item-key-encoded>` atom matching the current principal + work-item. Match -> skip resume + write `resume-reset-consumed` (referencing the matched reset atom and the new session atom that fresh-spawned in its place). No match -> proceed with the strategy ladder.

Construction time cannot enforce this because `wrapIfEnabled` runs once per runner-script invocation but the work-item key is only known once `AgentLoopInput` arrives at `acquire`. A single runner script may invoke the same wrapped adapter against multiple work-items in sequence (e.g. a batch CTO planning run across several intents); each invocation gets its own reset check.

## 7. Audit chain

PR #171's audit chain captures `metadata.agent_session.extra.resume_strategy_used` and `extra.resumed_from_atom_id` on the resumed session atom. These fields are populated by the wrapper after a successful resume (PR #171 §3.3). Broader coverage reuses the same shape unchanged; the only addition is the dashboard surface that projects across all actors (PR4 in section 8).

### 7.1 Audit fields (unchanged from PR #171)

```text
metadata.agent_session.extra.resumable_session_id  // adapter-neutral resume token
metadata.agent_session.extra.resumed_from_atom_id  // PRIOR session atom; null when fresh-spawn
metadata.agent_session.extra.resume_strategy_used  // strategy.name; absent on fresh-spawn
```

### 7.2 New audit field on the wrapper

The wrapped adapter writes an additional field on the session atom at the end of each `acquire(input)` call:

```text
metadata.agent_session.extra.resume_attempt: 'resumed' | 'fresh-spawn-no-strategy' | 'fresh-spawn-fallback' | 'fresh-spawn-reset' | 'fresh-spawn-policy-disabled'
```

`resume_attempt` distinguishes:
- `'resumed'`: a strategy resolved AND the resume invocation returned `completed`.
- `'fresh-spawn-no-strategy'`: no strategy resolved; the wrapper delegated directly.
- `'fresh-spawn-fallback'`: a strategy resolved but the resume invocation returned non-`completed`; the wrapper delegated to fresh-spawn.
- `'fresh-spawn-reset'`: an unconsumed operator-reset atom was found at invocation time; resume was skipped.
- `'fresh-spawn-policy-disabled'`: `wrapIfEnabled` short-circuited at construction time because the policy atom resolved to disabled; the underlying adapter was returned untouched, but if a runner explicitly tracks audit completeness it MAY write this field on every session atom for that principal so the resume-vs-fresh-spawn ratio in the PR4 dashboard reflects the off-policy fraction. Indie-floor runners do NOT need this to ship; the dashboard treats absence as "not in scope for this principal."

This is the field the PR4 dashboard projects to compute the resume-vs-fresh-spawn ratio per actor.

### 7.3 Cross-actor audit traversal

A future audit tool (e.g., a "session lineage walker" that traces the full chain of resumes for a given work-item) reads `extra.resumed_from_atom_id` recursively until it hits null. Because the field is uniform across actors, the same walker covers PrFixActor, CTOActor, code-author, and pipeline stages without per-actor branching. This is the key audit-chain win of unifying the registry shape.

## 8. Threat model

PR #171 §5 defined the threat-model for the same-machine and blob-shipped paths under PrFixActor. Broader coverage opens new attack surfaces; each is mapped against the existing threat-model framing.

### 8.1 Same-machine path (per-actor)

PR #171 §5.1 documented "no new exfiltration surface." That holds per-actor: the resume token is opaque, the session file lives on the operator's local CLI cache, and resume invocation is in-process with no network reach. Broader coverage does NOT change this.

### 8.2 Blob-shipped path (per-actor)

PR #171 §5.2 defined the four guards (acknowledgeSessionDataFlow, required redactor, destination guard, CLI-version guard). Broader coverage MUST inherit ALL FOUR per actor. The guards run in the strategy constructor; per-actor wiring just constructs more strategy instances, each with its own redactor + cliVersion + destination guards.

A new concern: an org-ceiling deployment running multiple actors (cto-actor, code-author, pipeline-stage) all configured to use blob-shipped strategies on the same BlobStore could mistakenly cross-pollinate sessions. The fix is the per-principal candidate walk: each walk filters to the same `principal_id` so a CTO walk never picks up a code-author session as a candidate, and vice versa. The walk-fn is the trust boundary; the BlobStore is shared but the candidate set is principal-scoped.

### 8.3 Cross-actor work-item leakage

If two different actors operate on the same work-item key (e.g., a hypothetical actor that also uses `intent_atom_id` as its key), a buggy walk-fn could surface the wrong actor's sessions as candidates. The mitigation is the same `principal_id` filter at the walk: a CTO walk checks `session.principal === 'cto-actor'` AND filters by `intent_atom_id`. A two-axis filter; both must pass.

This is a **structural concern** flagged per `dev-flag-structural-concerns-proactively`. The trade-off: making the walk-fn enforce both axes is one more line of filter logic per walk. The alternative (relying on work-item key uniqueness) is fragile because work-item keys are conceptually scoped to actors but are implemented as plain values that could collide. The recommended path is the two-axis filter.

### 8.4 Multi-tenancy scaling at 50+ concurrent actors

PR #171 §6.2 documented multi-tenancy concerns for PR-fix at 50+ concurrent actors:
1. Candidate-walk MUST be PR-scoped.
2. Concurrent fix-iterations on the same PR are sequential by construction.
3. Strategy enumeration cost is O(strategies).
4. Atom-store walk cost is O(prior-iterations).

For broader coverage, all four hold per-actor. The new concern at 50+ concurrent actors is the **registry contention**: every runner script constructs its own registry, but they all read the same canon policy atom. AtomStore.get is O(1) on the in-memory atom index per recent decision (`dec-console-in-memory-atom-index`); 50 concurrent reads are bounded by the index's read-lock contention, which is non-blocking. No additional design needed.

### 8.5 Compromised-session resume

If the prior session's atom carries `taint !== 'clean'` (e.g., it was tagged compromised post-hoc by a `compromise` atom), resuming it would propagate compromised reasoning into the new session. The fresh-spawn exception `taint-detected` (section 6.1) handles this: the registry's wrap-time check filters candidates by taint, and a tainted candidate is skipped. The exception is in the indie-floor default set so a deployment that opts into resume gets compromise-protection by default.

## 9. Structural concerns surfaced

Per `dev-flag-structural-concerns-proactively`, three structural concerns deserve explicit articulation. Each is articulated with the trade-off named; the recommended mitigation is in section 8 / 10.

### 9.1 Cross-actor work-item key collisions

Documented in section 8.3. The mitigation is two-axis filtering (`principal_id` + work-item key). The trade-off is one more filter line per walk-fn. Recommended: implement.

### 9.2 Registry as a runner-side singleton

The registry is constructed per-runner-script. Two concurrent runner scripts on the same machine each have their own registry. This is fine for correctness (they don't share state), but it means a registration is per-process: registering `cto-actor` in `run-cto-actor.mjs` does not magically register it in `run-code-author.mjs`. Each runner script must explicitly register the actors it cares about.

Trade-off: per-runner registration is a small amount of duplication (one `register()` call per runner per actor). The alternative, a global registry loaded from canon at process start, would eliminate the duplication but introduce ambient state and complicate testing. Recommended: keep per-runner registration; document the pattern in the registry's JSDoc.

### 9.3 Policy-atom drift across actor renames

If an org renames `cto-actor` to `apex-cto-actor` via a canon edit, the policy atom `pol-resume-strategy-cto-actor` no longer matches. The ramification: resume silently turns off until the operator catches the drift.

Trade-off: a substrate-side rename-aware lookup (e.g., the registry follows principal aliases) adds complexity for a rare event. The simpler path is documenting that renaming a principal requires updating the policy atom. Recommended: document; do not add rename-tracking.

## 10. Indie-floor / org-ceiling fit, blast radius, kill-switch

Mirrors PR #171 §6.5 framing.

- **Indie floor (solo developer):** zero behavior change. The policy atom is absent for every principal except `pr-fix-actor` (where PR #171 already wires it). A solo developer running `run-cto-actor.mjs` for the first time, or for the hundredth time, gets fresh-spawn. Resume costs nothing if it never runs.
- **Org ceiling (50+ concurrent actors, BYO adapters):** the registry primitive is the substrate seam. An org wires per-actor walk-fns, registers them in each runner, and ships canon policy atoms per principal to enable resume. Different agent loops (LangGraph for some actors, Claude Code for others) ship per-adapter strategies; the wrapper is unchanged.
- **Same architecture serves both ends.** No fork; no parallel "indie" vs "org" code paths. The capability dial is a canon policy atom + a runner-side `register()` call.
- **Blast radius:** broader resume coverage opens the same surfaces PR #171 opened for PR-fix, but per-actor. Each actor's blast radius is bounded by its own redactor + destination guard + cli-version pin. Cross-actor pollution is bounded by the two-axis walk filter.
- **Kill-switch:** unchanged. The wrapper inherits the underlying adapter's kill-switch behavior on every actor it wraps. Kill-switch on a resume-in-progress aborts cooperatively the same way it does on a fresh-spawn.

## 11. Implementation roadmap

### 11.1 PR1: Generalize `SessionResumeStrategy` registry (substrate)

Lands the `ResumeStrategyRegistry` primitive in `examples/agent-loops/resume-author/registry.ts` plus the `WorkItemKey` type union. No actor changes; no runner changes yet. Tests cover registry registration, lookup, two-axis filtering. The wrapper from PR #171 is unchanged.

Acceptance: `node scripts/run-pr-fix.mjs` continues to work bit-identically (the registry has one entry for `pr-fix-actor` mirroring PR #171's hard-coded wiring); a new `register()` call for `cto-actor` does not affect `run-pr-fix.mjs` runs.

Estimated size: ~250 LOC in `examples/agent-loops/resume-author/` + tests, cleanly split from current PR #171 code.

### 11.2 PR2: Per-actor walks for `cto-actor` + `code-author`

Lands the per-actor walk-fns in `examples/agent-loops/resume-author/walks/<actor-id>/walk.ts`. Each walk implements `assembleCandidates` for that actor's work-item key. Includes:

- `walks/cto-actor/walk.ts`: walks `intent_atom_id` chain.
- `walks/code-author/walk.ts`: walks `task_plan_atom_id`-keyed agent-session atoms.
- Renames `walk-author-sessions.ts` to `walks/pr-fix/walk.ts` for consistency.

Each runner script (`run-cto-actor.mjs`, `run-code-author.mjs`, `run-pr-fix.mjs`) is updated to construct its registry, register the relevant walk, and call `wrapIfEnabled`.

Acceptance: a same-machine resume of a CTO planning run works end-to-end with a hand-written canon policy atom; the resumed session atom carries the correct `extra.resumed_from_atom_id` and `extra.resume_strategy_used` and the registry's new `extra.resume_attempt`.

Estimated size: ~400 LOC including tests.

### 11.3 PR3: Per-actor canon policy atoms + opt-in defaults

Lands the `pol-resume-strategy-<principal-id>` atom shape, a bootstrap script that seeds the empty-default for `pr-fix-actor` (mirroring PR #171's hard-coded behavior so the substrate represents the same posture), and the substrate validator. The atom is read by `wrapIfEnabled` to decide enable/disable.

Acceptance: removing the `pol-resume-strategy-pr-fix-actor` atom flips PrFix back to fresh-spawn (regression check vs PR #171); adding `pol-resume-strategy-cto-actor` with `enabled: true` turns CTO-actor resume on.

Estimated size: ~200 LOC + bootstrap + tests.

### 11.4 PR4: Audit + dashboard surface

Lands a Console view at `/resume` that projects `metadata.agent_session.extra.resume_attempt`, `extra.resume_strategy_used`, and `extra.resumed_from_atom_id` across all actors and produces:
- A resume-vs-fresh-spawn ratio per principal over a configurable time window.
- A per-actor list of recent resumed sessions with click-through to the prior session.
- A surface for `resume-reset` atoms so the operator can see (and write) reset signals from the dashboard.

Acceptance: the dashboard shows non-zero resume-attempt counts after PR2 lands and pol atoms are seeded for `cto-actor` + `code-author`.

Estimated size: ~500 LOC across console server + frontend + tests.

### 11.5 Implementation discipline

Each PR ships through:
- The CR CLI pre-push gate (`dev-coderabbit-cli-pre-push`).
- The canon-compliance auditor sub-agent loop (`dev-implementation-canon-audit-loop`).
- The standard pre-push grep checklist (no AI attribution, no design/ refs in src/, no emdashes, no private terms).
- Bot-identity wrappers for all gh / git ops (`feedback_never_github_actions_as_operator`).

## 12. Alternatives rejected

### 12.1 Per-actor wrappers (instead of a registry)

**Rejected.** Discussed in section 3.2. Ships N copies of the wrapper; violates `dev-extract-helpers-at-n-2`; multiplies the test surface; obscures the "the wrapper is generic" property PR #171 was designed for.

### 12.2 Cross-actor session transfer (instead of per-actor resume)

**Rejected for now (out of scope, not a permanent rejection).** Cross-actor session transfer would let, e.g., a code-author run inherit the cto-actor session that produced its plan. This is conceptually attractive (shared reasoning) but has different shape concerns:

1. Cross-principal credential boundaries. A cto-actor session's tool-call traces include reads from canon under cto's tool policy; replaying them under code-author's tool policy is a policy-mismatch. The substrate has no concept of "transcripts under principal A consumable by principal B."
2. Different LLM context expectations. cto-actor produces a Plan atom as output; code-author consumes a Plan atom as input. Their conversation states are not equivalent; restoring cto's transcript into code-author's session would put code-author into a confusing prompt state.
3. The user benefit is unclear vs the simpler "code-author gets the plan + fileContents + verified-citations data block" pattern that already exists.

If a future workload demonstrates a real win for cross-actor transfer, it's a separate spec. This spec stays per-actor.

### 12.3 Single global toggle (instead of per-actor opt-in)

**Rejected.** Discussed in section 5.4. Different actors have different risk profiles; a global toggle either accepts the highest-risk actor's posture for everyone or builds a per-actor override mechanism on top, which is what we already have.

### 12.4 Auto-enable for any registered actor (instead of opt-in via canon policy)

**Rejected.** A registered walk-fn would imply enabled. The trade-off: registration is a code-side action (in the runner script); enabling is a governance action (canon edit). Conflating them removes the canon-edit gate that the dial-future-proofing canon (`dev-apex-tunable-trade-off-dials-future-seam`) requires for any behavior-changing dial. Keeping the canon policy atom as the gate preserves the substrate's "raise the dial via canon" pattern.

## 13. Approval gate

This spec is the work product of this dispatch. It is `status: proposed; needs operator approval before implementation`. None of the 4 PRs (section 8) ships before operator approval of this spec.

The operator's approval gate is exercised via the standard `/decide` flow OR the operator can directly approve by writing an operator-intent atom citing this spec's path with a trust envelope authorizing the 4 implementation PRs.

A useful pre-approval review checklist:
1. Does the inventory in section 1 match the actor surface the operator wants to extend? Any actor missing? Any included that should be excluded?
2. Does the work-item key table in section 4.1 use the right keys for each actor? In particular, is `intent_atom_id` the right CTO-actor key, or should it be the seed plan atom's id or another atom's id?
3. Are the fresh-spawn exceptions in section 6.1 the right finite ENUM? Should additional kinds be defined now (e.g., `network-exfiltration-detected`)?
4. Is the indie-floor opt-in default the right posture, or should resume be on-by-default for some actors at indie floor?
5. Does the 4-PR roadmap (section 11) match the operator's preferred sequencing? Should PR2 split CTO-actor and code-author into separate PRs?

## 14. Open follow-ups (not addressed by these 4 PRs)

- Cross-actor session transfer (section 12.2).
- Same-work-item parallelism (section 1.3 + PR #171 §6.6); would need a session-locking primitive.
- Encryption-at-rest for session-content blobs (PR #171 §5.3); same scope as the original spec, not actor-specific.
- A per-actor "operator notification on resume" hook (analogous to PR #171 §5.3's blob-capture notification) so the operator sees a notification each time a resume happens. Could ship as a strategy-level option without a substrate change.
