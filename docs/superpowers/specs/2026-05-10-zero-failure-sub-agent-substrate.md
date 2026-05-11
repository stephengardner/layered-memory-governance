# Zero-Failure Sub-Agent Substrate

**Date:** 2026-05-10
**Status:** Spec v3 (post second spec-document-reviewer pass), awaiting operator review
**Provenance:** Operator-driven brainstorming session 2026-05-10, decisions Q1-Q5 captured below.

---

## Changelog

**v3 (2026-05-10, after second reviewer pass):** All 2 new critical + 3 new major + 3 new minor v2 issues closed. (1) `claim_secret_token` is rotated on every Phase B recovery in the same atomic put that increments `recovery_attempts`; the recovery brief threads the new token; old-token attestations are rejected with `token-mismatch`. (2) `deadline_ts` is extended on every recovery via `pol-claim-recovery-deadline-extension-ms` (default 30 min), preventing instant re-stalls of the just-recovered claim. (3) AtomStore write-time policy for `claim-attestation-*` is documented as a layered defense -- primary gate is per-principal PreToolUse hook rejecting writes from sub-agent principals; in-process forgery by a compromised contract module is escalated to the medium-tier kill switch concern (canon D13). (4) Verifier failure ping-pong bounded by `verifier_failure_count` field capped at `pol-claim-verifier-failure-cap` (default 3); after the cap, reaper flips straight to `stalled`. (5) Phase A condition #3 (executing session finalized) adds a debounce via `pol-claim-session-post-finalize-grace-ms` (default 30s) to avoid racing the in-flight attest. (6) STOP-rejected attest calls now write `claim-attestation-rejected` with reason `stop-sentinel` for audit completeness. (7) Section 16 clarifies "no canon ids in src/ JSDoc; doc-prose may reference them freely." **v2 (2026-05-10, after first reviewer pass):** Closed 5 critical + 5 major + 4 minor v1 issues: token+principal binding, verifier crash/timeout, past-deadline gate, post-terminal misbehavior, two-phase reaper, brief size cap. **v1 (2026-05-10):** Initial draft post brainstorming Q1-Q5.

---

## 0. Frame

Operator directive (verbatim, 2026-05-10):

> "the real answer is to make sure that we increase budgets or do literalyl WEHATEVER we have to do to ensure nothing EVER fails"
>
> "spec it for fix as soon as possible, these are fundamental things we need to fix. What we want is an enterprise product that ships code and truly minimizes errors, and maximizes the work and the effort and the knowledge such that it ships the right fix the first time"

Observed failure pattern (3/3 sub-agent dispatches today, 2026-05-10):

- Sub-agent for Task #311 (operator-action audit-trail dashboard): stalled mid-flight; parent took over.
- Sub-agent for Task #294 (agent-turn streaming): completed work but exited before push; parent pushed.
- Sub-agent `acf1e48767993b0fd` for Task #329: completed all commits, exited before pushing PR #389; parent pushed. (This sub-agent then RECOVERED itself for PR #390, so behavior is bimodal: sometimes sub-agents drive to terminal cleanly, sometimes not.)

Canon `dev-sub-agent-pr-driver-responsibility` already says "the sub-agent owns the PR through MERGED, parent re-dispatches on orphan-after-5min." The discipline is encoded. The 3/3 violations today show the discipline is not enforced at the substrate level; without enforcement, future agents will continue to violate it.

The operator's framing -- "ship the right fix the first time," "minimize errors," "enterprise product" -- argues for substrate-level enforcement rather than stronger doctrine.

---

## 1. Goals

1. **Substrate-enforced terminal-state contract.** A sub-agent cannot exit with `terminal-success` while its assigned work is in a non-terminal state. The contract is checked by substrate code, not by discipline alone.
2. **Defense-in-depth recovery.** When (and only when) the contract is violated, substrate auto-recovers via a bounded tiered ladder (resume then fresh-spawn then escalate).
3. **Budget cannot be the failure reason.** Each claim has a tiered budget ladder; on each recovery attempt, the substrate auto-promotes to the next tier. Solo-developer indie-floor stays bounded; org-ceiling dials the max via canon edit.
4. **Universal work-item handle.** A single `work-claim` atom type generalizes across PR-driving, plan-driving, task-driving, and research dispatches. Adding a new work-shape only requires a new verification handler, not a new substrate primitive.
5. **Full audit chain.** Every claim, attestation (accepted or rejected, including STOP-rejected), recovery attempt, and escalation lands as an atom with `provenance.derived_from` chaining back to the seed intent.
6. **Forgery-resistant attest.** A sub-agent's attestation is bound to its claim's secret token AND its principal identity; the token is rotated on every recovery so a zombie sub-agent from a prior attempt cannot race a fresh one.

## 2. Non-Goals

- **Making bad code automatically good.** Sub-agent output quality is orthogonal to terminal-state enforcement; this spec addresses *did the agent finish what it was given*, not *did it do it well*. Code quality remains the responsibility of CR + LAG-auditor + cr-precheck.
- **Removing operator gates on canon writes.** L3 canon promotion remains operator-signed per `inv-l3-requires-human`. The budget ladder dial is itself a canon edit; raising or lowering it produces an audit-trailed decision atom.
- **Auto-merging without operator approval.** Merge authority stays with the operator (or lag-cto under medium-tier kill switch, per canon `dec-autonomous-merge-endgame`). A `work-claim` reaching `complete` state means the work-item is in its expected terminal -- which for PRs is MERGED, the merge having been performed by the authorized actor, not by the substrate.
- **Cross-agent claim handoff.** A claim is dispatched to one principal; if recovery moves it to a different principal, that's a new claim (new id, `parent_claim_id` link). This spec does not introduce multi-principal claim semantics.
- **Hard-killing runaway sub-agents.** The substrate detects post-terminal misbehavior and escalates via Notifier, but does not forcibly terminate processes -- that is the operator's STOP path. Substrate-side mid-process kill is a future medium-tier kill switch concern (canon D13).
- **In-process forgery of `claim-attestation-*` atoms by a compromised contract module.** The substrate ships defense-in-depth (PreToolUse hook + token + principal + verifier) but does not introduce a new AtomStore caller-module capability primitive; an attacker who has compromised the substrate's own contract layer has already won. Mitigation is medium-tier kill switch + operator STOP.

## 3. Decisions captured

The brainstorming session settled five foundational questions before the design was written:

| Q   | Question                                  | Decision | Rationale                                                                                                                                                                                                       |
| --- | ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Contract shape                            | (c) layered: contract + reaper | A contract without a fallback is just discipline (which already failed 3/3 times today). Contract first to catch the cheap 95%; reaper as the floor for the residual 5%.                                       |
| Q2  | Work-item handle                          | (3) new `work-claim` atom | Generalizes across PR-driving + pre-PR (e.g. research) + post-PR cases. PR-only handle would miss 1/3 of today's failures.                                                                                       |
| Q3  | Completion semantics                      | (b) sub-agent attests + substrate verifies | Preserves audit chain ("agent thought it was done, here's what they checked") while making substrate the final word. Pure substrate-observed would lose the rich audit signal.                                  |
| Q4  | Recovery action                           | (c) tiered: resume then fresh then escalate (N=3) | Resume-first preserves knowledge per "maximize work and effort." Bounded recursion prevents resource burn on broken claims. Escalation is the audit-trail terminus.                                              |
| Q5  | Budget posture                            | (b) tiered budget ladder | Substrate auto-raises tier on each recovery; directly executes "increase budgets." Default tier sized for typical PR-fix burn; max tier is the operator-dialed ceiling. Indie zero-config, org-dialable via canon. |

Architecture phasing chosen: **Approach 2 (foundational substrate first)** -- ship substrate primitives in 1-2 PRs with zero principal-specific wiring, then migrate each of the 5 principals in follow-up PRs.

## 4. Architecture

The substrate adds three components plus one new atom type. The existing Host interface is unchanged.

```text
Existing                          New
────────                          ───
AtomStore                         work-claim atom type
PrincipalStore                    (lifecycle states, schema)
LLM                               
Notifier                          dispatchSubAgent(brief, expected_terminal, caller_principal_id)
Scheduler          ───────►       └─► writes work-claim atom (state=pending) with claim_secret_token
Auditor                           └─► invokes existing AgentLoopAdapter
CanonStore                        └─► returns ClaimHandle (with token)
Clock                             
                                  markClaimComplete(claim_id, claim_secret_token,
                                                    caller_principal_id, attestation)
                                  └─► verifyTerminal(kind, identifier, expected_states)
                                  └─► writes claim-attestation-{accepted,rejected}
                                  
                                  runClaimReaperTick(host)
                                  └─► Phase A: detect stalls (flip claim_state to "stalled")
                                  └─► Phase B: drain stalled queue
                                       ├── rotate claim_secret_token
                                       ├── extend deadline_ts
                                       ├── increment recovery_attempts + bump budget_tier
                                       └── dispatch recovery (resume or fresh)
                                  └─► both phases atomic-version-checked, locks released between
```

**File layout (PR1 + PR2 deliverables):**

- `src/atoms/types.ts`                                -- additive: `WorkClaimAtom` shape, `claim_state` union, attestation-result atom types.
- `src/substrate/claim-contract.ts`                   -- new: `dispatchSubAgent`, `markClaimComplete`, `ClaimHandle`, verification dispatcher, claim-secret-token helpers (generate + rotate + constant-time compare).
- `src/substrate/claim-verifiers/`                    -- new: verification handlers, one per `terminal_kind`. `pr.ts`, `plan.ts`, `task.ts`, `research-atom.ts` + `index.ts` registry.
- `src/runtime/loop/claim-reaper.ts`                  -- new: `runClaimReaperTick(host)`, `detectStalledClaims`, `drainStalledQueue`, `recoverStalledClaim`.
- `bootstrap/canon/pol-claim-budget-tier-default.json` -- default tier ($2.00).
- `bootstrap/canon/pol-claim-budget-tier-raised.json`  -- raised tier ($5.00).
- `bootstrap/canon/pol-claim-budget-tier-max.json`     -- max tier ($10.00).
- `bootstrap/canon/pol-claim-reaper-cadence-ms.json`   -- reaper cadence dial (60_000 ms default).
- `bootstrap/canon/pol-claim-recovery-max-attempts.json` -- N=3 recovery cap dial.
- `bootstrap/canon/pol-claim-recovery-deadline-extension-ms.json` -- extension on each recovery (1_800_000 ms = 30 min default).
- `bootstrap/canon/pol-claim-attesting-grace-ms.json`  -- grace clock after attest rejection (300_000 ms default).
- `bootstrap/canon/pol-claim-pending-grace-ms.json`    -- grace after dispatch before agent must show signs of life (60_000 ms default). Referenced by Section 7 Phase A stall condition #2.
- `bootstrap/canon/pol-claim-verifier-timeout-ms.json` -- verifier hard timeout (30_000 ms default).
- `bootstrap/canon/pol-claim-verifier-failure-cap.json` -- verifier-failure (timeout OR error) ping-pong cap (3 default).
- `bootstrap/canon/pol-claim-session-post-finalize-grace-ms.json` -- debounce for Phase A condition #3 to avoid racing in-flight attest (30_000 ms default).
- `bootstrap/canon/pol-loop-pass-claim-reaper-default.json` -- PR2: default-on dial for reaper in LoopRunner.
- `bootstrap/bootstrap-claim-contract-canon.mjs`       -- one-shot operator script to seed the canon atoms.

**What stays the same:**

- 8 Host sub-interfaces. No new Host method.
- Existing `AgentLoopAdapter` interface. The claim-contract layer wraps it without changing it; legacy direct-dispatch paths continue to work.
- The 5 stage adapters + 5 actor principals. They adopt the contract in follow-up PRs (PR3-7).
- The existing reaper (`runReaperSweep` for stale plans/pipelines) keeps running unchanged. The claim reaper is an additional, parallel tick.
- `AtomStore.put` signature unchanged. The "only the contract module writes `claim-attestation-*`" guarantee is enforced at the existing PreToolUse hook layer keyed on principal_id, not via a new AtomStore caller-module primitive (see Section 11 row 11).

**Substrate purity audit (per `dev-substrate-not-prescription` + `dev-indie-floor-org-ceiling`):**

`src/substrate/claim-contract.ts` is mechanism-only. No principal names, no work-shape assumptions, no hardcoded budget values. The verifier dispatcher reads `terminal_kind` from the atom and dispatches to the matching handler -- adding a new work-shape only adds a new file in `src/substrate/claim-verifiers/`, never changes the contract layer. `runClaimReaperTick` reads cadence + recovery max + budget tiers + verifier timeout + verifier-failure cap + session-finalize grace + deadline extension from canon-policy atoms; no constants in the runtime path. Canon policies are read by *kind* + *scope* (the existing arbitration mechanism), never by atom id, so the src/ "no canon ids in JSDoc" rule (per `feedback_src_docs_mechanism_only_no_design_links`) holds. Doc-prose may reference canon ids freely; the JSDoc fence is the gate.

## 5. `work-claim` atom schema

New atom type at layer `L0` (runtime record, not canon).

```ts
interface WorkClaimAtom extends AtomBase {
  type: "work-claim";
  layer: "L0";
  principal_id: string;       // the dispatching principal (e.g. cto-actor)
  content: string;            // short human-readable description
  confidence: 1.0;            // L0 records are not probabilistic
  provenance: {
    kind: "machine-dispatched";
    derived_from: string[];   // intent/plan/operator atom ids
    source_chain: ProvenanceLink[];
  };
  metadata: {
    work_claim: {
      claim_id: string;                  // == atom.id, denormalized for lookup
      claim_secret_token: string;        // crypto-random; rotated on every recovery; bound to attest calls
      dispatched_principal_id: string;   // the sub-agent's principal
      brief: {
        prompt: string;
        prompt_blob_ref?: string;        // BlobStore ref when inline > 16 KB
        expected_terminal: {
          kind: "pr" | "plan" | "task" | "research-atom" | string;
          identifier: string;             // pr number | plan id | task id | atom id
          terminal_states: string[];      // non-empty: any-of acceptable states
                                          // example: ["MERGED"] for pr
                                          // example: ["succeeded","abandoned"] for plan
        };
        deadline_ts: string;              // ISO-8601 UTC; substrate rejects past-dated at dispatch;
                                          // extended on every recovery
      };
      claim_state:
        | "pending"
        | "executing"
        | "attesting"
        | "complete"
        | "stalled"
        | "abandoned";
      budget_tier: string;                // open-extensible; canon-validated
                                          // ships with: "default" | "raised" | "max"
                                          // org may add: "emergency" | custom tiers
      recovery_attempts: number;          // 0 on initial dispatch
      verifier_failure_count: number;     // increments on verifier-timeout / verifier-error
                                          // resets to 0 on recovery; capped via pol-claim-verifier-failure-cap
      parent_claim_id: string | null;     // for nested dispatches
      session_atom_ids: string[];         // agent-session atoms produced by attempts
      last_attestation_rejected_at: string | null;  // ISO-8601 UTC; null until first rejection
                                                    // used by reaper Section 7 step 3c grace clock
      latest_session_finalized_at: string | null;  // ISO-8601 UTC; set when most recent session finalizes
                                                    // used by reaper Section 7 step 3b debounce
    };
  };
}
```

### `budget_tier` open-extensibility

The substrate ships with three reference tiers (`default`, `raised`, `max`) but `budget_tier` is a free-form string at the atom-schema level. At write time (and on each recovery), `dispatchSubAgent` validates that `claim.budget_tier` resolves to a canon-policy atom of `kind: "claim-budget-tier"` whose `metadata.policy.tier` matches the string. An org-ceiling deployment adds an `"emergency"` tier by writing `pol-claim-budget-tier-emergency.json` to canon; substrate then accepts that tier value. Per `dev-substrate-not-prescription`, the substrate is open for extension; tiers are policy.

### `claim_secret_token` derivation and rotation

Generated at `dispatchSubAgent` time via `crypto.randomBytes(32).toString('base64url')`. Lives only inside `metadata.work_claim.claim_secret_token` of the claim atom AND inside the brief context block delivered to the sub-agent. The token never appears in agent-session/agent-turn atoms (those redact via the existing PR1 redactor seam).

**Rotated on every Phase B recovery dispatch** (Section 7). The new token is generated in the same atomic `AtomStore.put` that increments `recovery_attempts`, ensuring any zombie sub-agent from a prior attempt fails its attest with `token-mismatch` even if its caller_principal_id still matches. This is the load-bearing defense against zombie-races: a stalled sub-agent that the reaper believed dead but that is actually still running cannot retroactively complete a claim that has moved on.

### Lifecycle

```text
                                   ┌───────────────────┐
                                   │       STOP        │
                                   │  short-circuits   │
                                   │  ALL transitions  │
                                   └───────────────────┘

  dispatchSubAgent()
        │
        ▼
   ┌──────────┐  agent loop  ┌────────────┐  attest call  ┌────────────┐
   │ pending  │ ───────────▶ │ executing  │ ────────────▶ │ attesting  │
   └──────────┘              └────────────┘               └────────────┘
        │                          ▲   │                       │   │
        │                          │   │ sub-agent re-engages  │   │ accepted
        │                          │   │ after rejection       │   ▼
        │                          │   │                  ┌──────────┐
        │                          │   │                  │ complete │
        │                          │   │                  └──────────┘
        │                          │   │
        │                          │   │ rejected (stays in attesting,
        │                          │   │           grace clock running)
        │                          │   │
        │            ┌─────────────┘   │
        │            │   reaper        │
        │            │   detects       │
        │            │   stall         │
        │            ▼                 │
        │       ┌──────────┐           │
        └─────▶ │ stalled  │ ◀─────────┘
                └──────────┘
                     │
            Phase B: drainStalledQueue
                     │
       ┌─────────────┼──────────────────────┐
       │             │                      │
attempts<max     attempts<max       attempts>=max
+ session exists + no session
+ resume avail   OR resume unavail
       │             │                      │
       ▼             ▼                      ▼
  resume retry   fresh respawn        ┌────────────┐
  (executing,    (executing,          │ abandoned  │
   new token,    new token,           └────────────┘
   ext deadline) ext deadline)        + claim-escalated atom
                                      + Notifier message
```

The `attesting → executing` transition exists when the sub-agent receives a `claim-attestation-rejected` and re-engages within the grace window. The grace clock starts at `last_attestation_rejected_at`. If the grace clock expires with the claim still in `attesting`, or `verifier_failure_count >= pol-claim-verifier-failure-cap`, the reaper flips straight to `stalled`.

The `pending → stalled` transition exists when the reaper detects a claim whose deadline has passed AND `session_atom_ids` is empty (the agent loop never started; e.g., adapter dispatch errored after the atom write).

### Adding a new terminal kind

To support a new work-shape (e.g. `git-tag-push`), the only additions are:

1. Add `"git-tag-push"` to the `kind` union in `WorkClaimAtom.metadata.work_claim.brief.expected_terminal.kind` (the union is open at the atom-schema level; the validator gates).
2. Add `src/substrate/claim-verifiers/git-tag-push.ts` exporting `verifyGitTagPushTerminal(identifier: string, expected_states: string[]): Promise<VerifierResult>`.
3. Register the verifier in `src/substrate/claim-verifiers/index.ts`.

No changes to the contract layer, the reaper, the recovery logic, or any actor.

## 6. Dispatch + attest contract

Two new substrate functions in `src/substrate/claim-contract.ts`.

### `dispatchSubAgent`

```ts
export interface DispatchSubAgentInput {
  brief: WorkClaimBrief;
  caller_principal_id: string;       // who is dispatching; from script context
  budget_tier?: string;              // default: "default"
  parent_claim_id?: string | null;   // for nested dispatches
  agent_loop_adapter: AgentLoopAdapter;
}

export interface DispatchSubAgentOutput {
  claim_id: string;
  claim_secret_token: string;        // returned to caller; threaded to sub-agent in brief
  claim_handle: ClaimHandle;
}

export interface ClaimHandle {
  settled(): Promise<{ final_state: "complete" | "abandoned"; reason?: string }>;
  read(): Promise<WorkClaimAtom>;
}

export async function dispatchSubAgent(
  input: DispatchSubAgentInput,
  host: Host
): Promise<DispatchSubAgentOutput>;
```

Pre-dispatch validation (fail-fast; throws `SubstrateError`):

1. **STOP check.** `.lag/STOP` active? Throw `stop-sentinel-active`.
2. **Caller identity.** `caller_principal_id` must resolve in `host.principalStore`. Throw `unknown-caller`.
3. **Verifier registered.** `brief.expected_terminal.kind` must have a registered handler. Throw `unknown-terminal-kind`.
4. **Deadline future-dated.** `parseISO(brief.deadline_ts) > host.clock.now()`. Throw `deadline-already-past`. Prevents the reaper from instantly flagging a fresh claim stalled due to clock skew or stale brief reuse.
5. **Budget tier resolves.** Canon policy lookup by `kind: "claim-budget-tier"` + `tier: input.budget_tier` returns an atom. Throw `unknown-budget-tier`. The tier ladder is canon-policy, never hardcoded.
6. **Prompt size.** If `brief.prompt.length > 16_384`, spill the overflow to BlobStore via `host.blobStore.put(brief.prompt, { kind: "work-claim-prompt" })` and store the resulting BlobRef in `brief.prompt_blob_ref`. The atom carries `brief.prompt` truncated with the BlobRef trailer.

On success:

1. Generate `claim_secret_token` via `crypto.randomBytes(32).toString('base64url')`.
2. Write the `work-claim` atom with `claim_state="pending"`, populated `brief`, `budget_tier`, `recovery_attempts: 0`, `verifier_failure_count: 0`, generated token.
3. Invoke the injected `AgentLoopAdapter` with the brief prompt + a `WORK_CLAIM_CONTEXT` block prepended (see "Contract surface" below).
4. Transition claim to `executing` immediately after adapter dispatch initiates (single atom `put` with optimistic version check).
5. Return `{ claim_id, claim_secret_token, claim_handle }` synchronously.

The token return enables the caller to thread the token into adapter context AND to perform attest calls on behalf of sub-agents that lack their own attest entry point.

### `markClaimComplete`

```ts
export interface AttestationInput {
  terminal_kind: string;
  terminal_identifier: string;
  observed_state: string;
}

export interface AttestationResult {
  accepted: boolean;
  reason?:
    | "stop-sentinel"
    | "claim-not-found"
    | "claim-already-terminal"
    | "token-mismatch"
    | "principal-mismatch"
    | "identifier-mismatch"
    | "kind-mismatch"
    | "ground-truth-mismatch"
    | "verifier-error"
    | "verifier-timeout";
  observed_state?: string;
}

export async function markClaimComplete(input: {
  claim_id: string;
  claim_secret_token: string;
  caller_principal_id: string;
  attestation: AttestationInput;
}, host: Host): Promise<AttestationResult>;
```

Validation gates (each writes a `claim-attestation-rejected` atom on rejection for audit):

1. **STOP check.** Active? Write `claim-attestation-rejected` with reason `stop-sentinel`; return `{ accepted: false, reason: "stop-sentinel" }`. Audit trail captures attempts during STOP.
2. **Claim lookup.** Atom with `id === claim_id` exists? Else `claim-not-found`.
3. **State guard.** `claim.claim_state ∈ {executing, attesting}`. If `complete` or `abandoned` → `claim-already-terminal`. Write `claim-attestation-rejected` + send `principal-misbehavior` actor-message to operator. Sub-agents writing post-terminal attest calls are runaway processes; the substrate surfaces them rather than ignoring.
4. **Token match.** Constant-time compare `input.claim_secret_token === claim.metadata.work_claim.claim_secret_token`. Else `token-mismatch` (forgery signal OR zombie sub-agent from pre-recovery generation). The token lives at the top level of `markClaimComplete`'s input (not inside `attestation`), matching the function signature.
5. **Principal match.** `caller_principal_id === claim.dispatched_principal_id`. Else `principal-mismatch`.
6. **Identifier match.** `attestation.terminal_identifier === claim.brief.expected_terminal.identifier`. Else `identifier-mismatch`.
7. **Kind match.** `attestation.terminal_kind === claim.brief.expected_terminal.kind`. Else `kind-mismatch`.
8. **Transition to attesting.** Flip claim_state with optimistic version check.
9. **Verifier dispatch.** Call the registered verifier wrapped in `Promise.race` against a `pol-claim-verifier-timeout-ms` timeout (default 30s):
   - **Returns `{ ok: true }`** → write `claim-attestation-accepted`, flip claim to `complete`, reset `verifier_failure_count` to 0 (same atomic put), return `{ accepted: true }`. The reset prevents legitimate ground-truth-mismatch cycles from accumulating prior verifier-infrastructure failures into the cap; `verifier_failure_count` only counts *consecutive* infrastructure failures (timeout/error), not lifetime.
   - **Returns `{ ok: false, observed_state }`** → write `claim-attestation-rejected` with `reason: "ground-truth-mismatch"` and observed state; claim stays in `attesting`; `last_attestation_rejected_at` set to `now()`; sub-agent may re-attempt within grace window.
   - **Throws** → write `claim-attestation-rejected` with `reason: "verifier-error"`, increment `verifier_failure_count`; if count >= `pol-claim-verifier-failure-cap` (default 3), flip claim_state to `stalled` directly (bypassing grace clock; loops bounded). Else claim stays in `attesting`; `last_attestation_rejected_at` set to `now()`.
   - **Times out** → write `claim-attestation-rejected` with `reason: "verifier-timeout"`, increment `verifier_failure_count`; same cap behavior as throw.

Every rejection writes an atom with `provenance.derived_from: [claim_id]` so the audit chain surfaces in the Console activity feed and in any future analytics.

### Contract surface to sub-agent

Every dispatched brief is prepended with this block, generated by the contract layer:

```text
═══════════════════════════════════════════════════════════════════════
WORK CLAIM CONTEXT (substrate-enforced, do not paraphrase)
═══════════════════════════════════════════════════════════════════════
claim_id:               work-claim-<uuid>
claim_secret_token:     <base64url-32-byte>
caller_principal_id:    <your-principal>
expected_terminal:      { kind: "pr", identifier: "<N>", terminal_states: ["MERGED"] }
deadline:               <ISO-8601>
budget:                 $<USD>
verifier_timeout:       <ms>

Before exit, you MUST call markClaimComplete({
  claim_id,
  claim_secret_token,
  caller_principal_id,
  attestation: {
    terminal_kind: "<kind>",
    terminal_identifier: "<id>",
    observed_state: "<what you observed via ground truth>"
  }
})

Substrate verifies your attestation against ground truth (e.g. GitHub
API for PR state). The token + principal are checked first; ground
truth second. Mismatch is a loud rejection; the claim stays open and
the reaper recovers. Your terminal-success report is advisory until
substrate accepts your attestation.

NOTE: if your work-claim has been recovered (recovery_attempts > 0),
the token in your brief is the CURRENT token; a token from a prior
attempt is invalidated and will reject as token-mismatch.

If you cannot reach the expected terminal, do NOT call
markClaimComplete. Exit; the reaper determines next steps.

DO NOT echo the claim_secret_token in any user-facing output, commit
message, PR body, or atom content. Redactors strip it from
agent-session/agent-turn atoms; respect the redaction.
═══════════════════════════════════════════════════════════════════════
```

## 7. Claim reaper

`runClaimReaperTick(host)` in `src/runtime/loop/claim-reaper.ts`, called from `LoopRunner` alongside `runReaperSweep`. **Two-phase**: detection and recovery are decoupled so the long-running adapter dispatch in recovery does not hold any claim-lock.

```text
runClaimReaperTick(host)
  │
  ├── STOP check → halt if active
  │
  ├── Phase A: detectStalledClaims(host)
  │     query open claims (state in {pending, executing, attesting})
  │     for each, check stall conditions (debounced)
  │     atomic-version-checked put: state → "stalled"
  │     write claim-stalled atom (audit trail)
  │     RELEASE all locks
  │
  └── Phase B: drainStalledQueue(host)
        query state="stalled" claims  
        for each:
          - atomic-version-checked put:
              increment recovery_attempts
              bump budget_tier per ladder
              rotate claim_secret_token (new randomBytes 32)
              extend deadline_ts by pol-claim-recovery-deadline-extension-ms
              reset verifier_failure_count to 0
              state → "executing"
              IN ONE put OPERATION; if version-check fails, skip
              (another reaper is recovering this claim)
          AFTER the put succeeds, fire-and-forget dispatch via
                  dispatchSubAgent OR ResumeAuthorAgentLoopAdapter
                  using the NEW token in the recovery brief
          RELEASE all locks
```

### Phase A: stall detection

Stall conditions (any one flips claim to `stalled`):

- `host.clock.now() > parseISO(claim.brief.deadline_ts)` for any state.
- `claim_state === "pending"` AND `(now - claim.created_at) > pol-claim-pending-grace-ms` (default 60_000 ms). Catches dispatches that errored after the atom write but before the adapter actually invoked.
- `claim_state === "executing"` AND every `agent-session` atom in `claim.session_atom_ids` has a finalized `terminal_state` (no in-flight sessions) AND `(now - claim.latest_session_finalized_at) > pol-claim-session-post-finalize-grace-ms` (default 30_000 ms). The debounce prevents racing an in-flight attest call from a sub-agent that just finalized its session-stream atom but has not yet called `markClaimComplete`.
- `claim_state === "attesting"` AND (`last_attestation_rejected_at !== null` AND `(now - last_attestation_rejected_at) > pol-claim-attesting-grace-ms` (default 300_000 ms = 5 min)). The sub-agent received a rejection and did not re-attempt within the grace window.
- `claim_state === "attesting"` AND `verifier_failure_count >= pol-claim-verifier-failure-cap` (default 3). Verifier ping-pong cap: a sub-agent that triggers repeated verifier failures (timeout or error) is flipped straight to stalled regardless of grace clock.

For each stalled claim:

1. Write `claim-stalled` atom recording the reason + a snapshot of `recovery_attempts` and `verifier_failure_count`.
2. Atomic-version-checked `AtomStore.put` flipping `claim_state` to `stalled`.
3. If the `put` fails the version check, skip (another reaper instance handled this claim).

### Phase B: recovery dispatch

Phase B is a separate query + iteration over `state="stalled"` claims. Decoupled from Phase A so a long-running adapter dispatch does not block other claim transitions.

For each stalled claim:

1. **Cap check.** Read `pol-claim-recovery-max-attempts` (default 3). If `claim.recovery_attempts >= max_attempts`:
   - Write `claim-escalated` atom with the failure reasons (gathered from prior `claim-stalled` atoms) + a snapshot of all `session_atom_ids`.
   - `host.notifier.telegraph` a `claim-stuck` actor-message atom to the operator.
   - Atomic put: flip claim to `abandoned`.
   - Continue.

2. **Atomic recovery-step.** ONE `AtomStore.put` with optimistic version check that:
   - Increments `recovery_attempts`.
   - Bumps `budget_tier` per the ladder (`default → raised`, `raised → max`, `max → max`). The ladder values come from `pol-claim-budget-tier-{tier}` canon policy.
   - **Rotates `claim_secret_token`** via `crypto.randomBytes(32).toString('base64url')`. The new token invalidates any attest call from a zombie sub-agent of a prior attempt with `token-mismatch`.
   - **Extends `deadline_ts`** to `max(claim.brief.deadline_ts, now() + pol-claim-recovery-deadline-extension-ms)` (default extension 30 min). Prevents instant re-stall on the next Phase A tick.
   - Resets `verifier_failure_count` to 0.
   - Updates `claim_state` to `executing`.
   - (Does NOT append session_atom_id yet -- that happens after dispatch initiates and the new session atom is written.)
   - If the put fails version check, another reaper is recovering this claim. Continue.

3. **Dispatch.** AFTER the put succeeds (lock effectively released):
   - If `claim.session_atom_ids.length === 0` (pending-state stall -- never started): fresh respawn via `dispatchSubAgent`. No resume path; no prior session exists.
   - Else if `recovery_attempts === 1` (first recovery, session exists): attempt resume via `ResumeAuthorAgentLoopAdapter` (PR6) against the last `agent-session` atom's `resumable_session_id`. If `walkAuthorSessions` returns null (session unrecoverable: blob shipped, model context overflow, stale beyond ttl) → fresh respawn fallback.
   - Else (`recovery_attempts >= 2`): fresh respawn with recovery brief (see Section 8).
   - In all cases, the recovery brief carries the NEW `claim_secret_token` (not the old one).
   - **Resume-path token injection.** When the resume path is taken, the new token reaches the resumed sub-agent's runtime via a `RECOVERY UPDATE` preamble that `ResumeAuthorAgentLoopAdapter` prepends to the resumed session's NEXT message. The resumed sub-agent processes the preamble as the first message of its new turn; subsequent attest calls use the new token. Without this injection, the resumed agent would carry only the prior token from its replayed context and would self-reject on its own attest. The preamble shape: `═══════════════════════════════════════════════════════════════════════\nRECOVERY UPDATE (substrate-enforced, do not paraphrase)\n═══════════════════════════════════════════════════════════════════════\nYour work-claim has been recovered (recovery_attempts: N).\nNEW claim_secret_token: <base64url-32-byte>\nNEW deadline: <ISO-8601>\nNEW budget_tier: <tier>\nDISCARD the token from your prior context; use the NEW token in your next markClaimComplete call.\n═══════════════════════════════════════════════════════════════════════`. PR6's `ResumeAuthorAgentLoopAdapter` gains a `preamble?: string` parameter accepting this update.

4. **Session atom append.** When the new dispatch's `agent-session` atom is written, append its id to `claim.session_atom_ids` via another atomic-version-checked put. Also update `latest_session_finalized_at` whenever a session reaches `terminal_state`.

Phase B never holds a lock across adapter dispatch. The optimistic version check on `recovery_attempts` increment ensures only one reaper dispatches the recovery; concurrent reapers see version-conflict and skip.

### Cadence

Both Phase A and Phase B run every `runClaimReaperTick`. Cadence read from `pol-claim-reaper-cadence-ms` (default 60_000 ms = 1 minute). Org-ceiling dials to 15_000 ms for sub-15s SLA.

## 8. Tiered recovery (brief composition)

When Phase B dispatches a fresh respawn, it composes a recovery brief. The brief size is capped at 16 KB inline; overflow spills to BlobStore.

```text
═══════════════════════════════════════════════════════════════════════
RECOVERY CONTEXT (this is recovery attempt N of <max>)
═══════════════════════════════════════════════════════════════════════
Previous attempt(s) stalled at: <last claim_state> (<reason>)
Previous attempts: <recovery_attempts>
Budget tier: <current tier>
Deadline (extended): <new deadline_ts>

Original brief:
<original prompt, or BlobRef to it if oversized>

Last 5 agent-turn entries:
<llm input/output excerpts, capped at 8 KB total>

Diff so far on the work branch (if any):
<git diff, capped at 4 KB; if larger, spill BlobRef>

Expected terminal: <expected_terminal>

═══════════════════════════════════════════════════════════════════════
Proceed to the expected terminal. Call markClaimComplete on the
SAME claim_id (recovery does not change the claim) using the NEW
claim_secret_token in this brief (your prior attempt's token is
invalidated).
═══════════════════════════════════════════════════════════════════════
```

### Size cap rationale

A multi-thousand-line diff threaded inline would land in the new attempt's `agent-turn` atoms via the LLM input. At indie-floor scale that bloats the atom store; at org-ceiling 50 actors that's a real storage problem. The 16 KB inline cap + BlobStore spill (per the PR #166 `BlobStore` seam + PR1 atom-store retention model) keeps atom sizes bounded.

If `git diff` for the work branch exceeds 4 KB, the spec writes:

```text
Diff so far on the work branch (full diff at blob://<ref>; first 4 KB inlined):
<first 4 KB>
[truncated; <N> additional lines; full diff via BlobStore at blob://<ref>]
```

The full diff is read via `host.blobStore.get(ref)` if the recovered sub-agent needs it; the atom only carries the inline summary.

### Pending-state stalls

If `claim.recovery_attempts === 0` AND `claim.session_atom_ids.length === 0` (a `pending` claim was flagged stalled because the dispatch errored after the atom write but before the adapter invoked an agent), recovery skips resume entirely and does fresh respawn at the current `budget_tier`. No prior session exists to resume.

## 9. Tiered budget ladder

Three reference canon policy atoms shipped via `bootstrap/canon/`. Defaults sized for typical-load PR-fix work (the highest-leverage substrate consumer):

```jsonc
// bootstrap/canon/pol-claim-budget-tier-default.json
{
  "id": "pol-claim-budget-tier-default",
  "type": "policy",
  "layer": "L3",
  "principal_id": "apex-agent",
  "content": "Default budget tier for sub-agent claims. Indie-floor sizing -- fits a typical PR-fix dispatch with headroom.",
  "confidence": 1.0,
  "provenance": { ... },
  "metadata": {
    "policy": {
      "kind": "claim-budget-tier",
      "tier": "default",
      "max_budget_usd": 2.00
    }
  }
}
```

```jsonc
// bootstrap/canon/pol-claim-budget-tier-raised.json
{ ..., "tier": "raised", "max_budget_usd": 5.00 }
```

```jsonc
// bootstrap/canon/pol-claim-budget-tier-max.json
{ ..., "tier": "max", "max_budget_usd": 10.00 }
```

Substrate resolves `claim.budget_tier` to the matching atom's `max_budget_usd` at `dispatchSubAgent` time and on every Phase B recovery dispatch. The resolved value is threaded into the `AgentLoopAdapter`'s budget cap.

### Default tier sizing rationale

Per `feedback_claude_cli_subscription_cost_model`: `--max-budget-usd $0.50` (today's CLI default) is a synthetic effort cap that throttles rich Opus runs. A solo developer dispatching a typical pr-fix at $0.50 frequently hits the throttle on the first try. The substrate ships `default=$2.00` instead so the first attempt usually completes within tier 0; the ladder only engages on hard cases.

### Indie-floor zero-config

Solo developer running LAG never has to know the tiers exist. The defaults cover the routine case; the ladder is the safety net for the abnormal case.

### Org-ceiling dial

An org-ceiling deployment writes higher-priority atoms (deployment-scoped principal id, e.g., `org-budget-policy`) with updated values. Per `dev-substrate-not-prescription`: raise the dial via canon edit, never in src/. The substrate's tier lookup uses `kind: "claim-budget-tier"` + `tier: <string>` arbitration; higher-priority atoms win.

### Adding a new tier

Per Section 5: `budget_tier` is an open-extensible string. To add `"emergency"`:

1. Write `bootstrap/canon/pol-claim-budget-tier-emergency.json` with `tier: "emergency"` + chosen `max_budget_usd`.
2. The substrate's tier validator (`dispatchSubAgent` step 5) now accepts `"emergency"` as a valid tier value.

No substrate code change required.

## 10. Kill-switch integration

`inv-kill-switch-first` is load-bearing throughout. The `.lag/STOP` sentinel halts the reaper at the top of every tick AND halts new dispatches at the top of `dispatchSubAgent` AND writes an audit rejection at the top of `markClaimComplete`:

```ts
export async function runClaimReaperTick(host: Host): Promise<TickResult> {
  if (await isStopSentinelActive(host)) return { halted: true, reason: "stop-sentinel" };
  // ... Phase A, Phase B
}

export async function dispatchSubAgent(input, host): Promise<DispatchSubAgentOutput> {
  if (await isStopSentinelActive(host)) throw new SubstrateError("stop-sentinel-active");
  // ... validation, write, invoke
}

export async function markClaimComplete(input, host): Promise<AttestationResult> {
  if (await isStopSentinelActive(host)) {
    await writeClaimAttestationRejected(host, input.claim_id, "stop-sentinel");
    return { accepted: false, reason: "stop-sentinel" };
  }
  // ... validation, verify
}
```

In-flight Phase B `recoverStalledClaim` calls finish their atom writes (do not leave half-written atoms). No NEW recovery attempts fire while STOP is present. Active claims sit in their current state -- `executing`, `attesting`, `stalled` -- until STOP is cleared. Operator inspects post-mortem.

A sub-agent that's already running when STOP is set continues to its own next tick (substrate does not kill mid-LLM-call); but cannot be re-dispatched, and its attest calls fail-closed with `stop-sentinel` AND an audit atom is written.

### No per-claim STOP

A per-claim STOP sentinel (`.lag/STOP-CLAIM-<id>`) was considered and rejected: multiplying sentinels adds operator cognitive load without adding capability. The single global STOP plus the `runtime abandon claim` operator-action (future Console UI per task #296) covers the granular case via the existing operator-action atom trail.

## 11. Threat model

The substrate adds new attack surfaces. Each is handled.

| Threat                                              | Mitigation                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised sub-agent attests "complete" for a claim it doesn't own | `markClaimComplete` step 4 (token match) rejects forgery: `claim_secret_token` is generated at dispatch time with 256 bits of entropy, embedded only in the dispatching brief context, and redacted from agent-session/agent-turn atoms. A sub-agent that does not hold the token cannot produce a passing attestation. Step 5 (principal match) is a defense-in-depth second gate: even if the token leaked, the calling principal must match `dispatched_principal_id`. |
| Zombie sub-agent from prior recovery attempt attests using its old token | Token is rotated on every Phase B recovery dispatch (Section 7 Phase B step 2). A zombie attempt holding the pre-rotation token fails step 4 (token-mismatch) and writes an audit atom. The post-rotation attempt receives the new token in its recovery brief. |
| Compromised sub-agent attests successfully then continues running | Step 3 (state guard) rejects `claim-already-terminal` for any post-`complete` attest. The substrate also writes a `principal-misbehavior` actor-message via Notifier when a post-terminal attest is detected, so the operator sees runaway sub-agents in the activity feed. Hard-killing the process is out of scope (Section 2); the operator triggers STOP. |
| Compromised sub-agent attests "complete" with falsified observed state | Verifier handler (Section 6 step 9) queries ground truth from external authoritative source (GitHub API for `pr`, AtomStore for `plan`, etc.). The sub-agent's `observed_state` is informational; substrate compares against verifier-returned state. Mismatch → rejection. Compromising the verifier requires a separate compromise (e.g., MITM on GitHub API), which is outside the substrate's threat boundary. |
| Verifier handler crashes or hangs                   | Wrapped in `Promise.race` with `pol-claim-verifier-timeout-ms` (default 30s). Verifier throw → `verifier-error` rejection, `verifier_failure_count++`. Timeout → `verifier-timeout` rejection, same count++. Both write `claim-attestation-rejected` and set `last_attestation_rejected_at`. After `pol-claim-verifier-failure-cap` (default 3) consecutive failures, reaper flips straight to `stalled` regardless of grace clock. Hung verifiers cannot stall the substrate forever AND cannot ping-pong the budget. |
| Runaway recovery (infinite N)                       | `pol-claim-recovery-max-attempts` (default 3) is a hard cap. Beyond it, the claim escalates and is abandoned. The cap atom is L3; modifying it requires operator signature. |
| Recovered claim instant re-stall                    | Phase B atomic put extends `deadline_ts` by `pol-claim-recovery-deadline-extension-ms` (default 30 min). The recovered claim has fresh deadline headroom. Phase A `now > deadline_ts` condition does not fire on the next tick. |
| Phase A race with in-flight legitimate attest call  | Phase A condition #3 (executing session finalized) requires `(now - latest_session_finalized_at) > pol-claim-session-post-finalize-grace-ms` (default 30s). Sub-agents that just finalized session-stream but have not yet called `markClaimComplete` get the grace window. |
| Canon-edit attack lowering budget tier              | Budget tier atoms are L3 + operator-signed; arbitration prefers operator-signed atoms via depth-tiebreaker; lowering the tier is itself an auditable canon-edit moment. |
| Session-resume from a hostile blob                  | Existing PR6 `BlobShippedSessionResumeStrategy` guards apply: default-deny construction, required redactor, destination guard, CLI-version pin. The claim-recovery layer inherits these without reimplementing. |
| Reaper running on a forked or partial atom store    | The reaper reads only atoms it itself has written or descended from the operator-signed canon. The verifier handlers query ground truth from external sources (GitHub, etc.) authenticated via bot-identity wrappers, not from the atom store. A partial atom store cannot fake a "PR is MERGED" verification. |
| Concurrent reaper ticks transitioning same claim    | All claim mutations use atomic-version-checked `AtomStore.put` (per PR #197 TOCTOU race fix). If two reaper invocations race, one's `put` fails the version check and aborts; the second's transition is the canonical one. Phase A and Phase B are decoupled so adapter dispatch never holds the lock. |
| Past-dated `deadline_ts` at dispatch                | `dispatchSubAgent` validation step 4 rejects past-dated deadlines with `deadline-already-past`. Prevents the reaper from instantly flagging a fresh claim stalled due to clock skew or stale brief reuse. |
| Direct write of `claim-attestation-accepted` by sub-agent principal | Primary gate: the existing per-principal PreToolUse hook (per `dev-attribution-hooks-cover-all-tool-paths`) rejects `AtomStore.put` of `claim-attestation-*` / `claim-stalled` / `claim-escalated` atoms when the calling principal is not the substrate's authorized writer (`apex-agent` per existing canon -- substrate writes are operator-authority-tier). The hook implements an allowlist on `(principal_id, atom_type)`: the substrate principal can write all claim-lifecycle atoms; sub-agent principals (cto-actor, code-author, pr-fix-actor, brainstorm-actor, cpo-actor) cannot write any of them directly. Routine sub-agent bypass attempts are rejected at write time. Defense-in-depth: even if the bypass succeeds at the hook layer, the verifier in `markClaimComplete` is not the same path -- a direct atom write cannot trigger a real GitHub verification, so the work-item terminal state remains observably wrong, and downstream consumers (e.g., the Console feed) see an attestation without a matching `claim-stalled→complete` lifecycle. **Residual risk:** an attacker who has compromised the substrate's own contract module can write any atom they want; that is a Tier 1 compromise outside this spec's threat boundary. Mitigation is medium-tier kill switch (canon D13) + operator STOP. This spec does not introduce a new AtomStore caller-module capability primitive; the existing hook is the gate. |
| Token leak via agent-turn atom                      | The redactor seam (PR1 `Redactor` interface) ships a default regex that matches the format `claim_secret_token:\s*[A-Za-z0-9_-]{43,}` (the literal label + a base64url token of >= 43 chars) AND a standalone regex for any 43+ char base64url string in `llm_input` / `llm_output` / tool-call args. Tokens are stripped from atom-store-persisted strings before write. The contract surface (Section 6) instructs the agent not to echo the token; redaction is the fallback. |

## 12. Indie-floor vs org-ceiling

Per `dev-indie-floor-org-ceiling`, every design decision must articulate how it serves both ends:

| Concern                              | Indie-floor (zero-config)                                                                                                                                | Org-ceiling (50+ actors)                                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget tiers                         | default=$2, raised=$5, max=$10. Solo developer's first sub-agent never knows the tiers exist; the defaults cover typical PR-fix work without throttling. | Deployment-scoped policy atoms set max=$50 or higher. Tier promotion is automatic; cost is predictable because every claim has a known ceiling. Custom tiers (e.g., `"emergency"=$100`) added via new policy atom -- no substrate change. |
| Reaper cadence                       | 60s default. Idle CPU is negligible.                                                                                                                     | 15s for tight SLA; or remove polling entirely and event-source-drive via Scheduler.NOTIFY (future seam reserved, not built). |
| Recovery max attempts                | 3. After 3 attempts, escalate to operator. Solo developer gets a Notifier ping; not blocked. | Same default; org may dial to 5 for high-noise environments, or to 1 for low-tolerance environments where stalls are rare. |
| Verifier timeout                     | 30s default. Covers typical GitHub API latency with margin. | Tune per integration (e.g., 60s for slow-to-respond internal CI). Dial via `pol-claim-verifier-timeout-ms`. |
| Verifier failure cap                 | 3 consecutive failures before forced-stall. Prevents budget burn from a repeatedly-hanging external service. | Org may dial to 1 (zero-tolerance) or 5 (high-noise). |
| Session-finalize grace               | 30s default. The window between session-stream final write and `markClaimComplete` call. | Tune per typical sub-agent post-session work (e.g., 10s for fast principals, 90s for slow principals). |
| Recovery deadline extension          | 30 min default. The recovered sub-agent gets a fresh half-hour window. | Adjust per typical work-shape duration; e.g., a recovery for a 4h research dispatch might want a 2h extension. |
| Resume path                          | PR6 `SameMachineCliResumeStrategy` (same-host, 8h staleness window). Always available for indie running on a single host. | Same plus opt-in `BlobShippedSessionResumeStrategy` (PR6) for multi-host org deployments. Default-deny opt-in per existing PR6 fence. |
| Verifier handlers                    | Default handlers for `pr` (GitHub), `plan` (AtomStore), `task` (TaskList), `research-atom` (AtomStore). Cover the 4 work-shapes LAG ships today. | Custom verifier handlers for proprietary work-shapes (e.g., `terraform-apply-completed`, `slack-message-acked`). Added under `src/substrate/claim-verifiers/<name>.ts` + registered in the index; no contract-layer change. |
| STOP sentinel                        | Already operator-known. No new operator concept.                                                                                                          | Same. No multi-tier STOP needed at this layer. |
| Notifier escalations                 | Single channel (Telegram or file queue). Operator gets the `claim-stuck` ping. | Org-channel (Slack escalation, paging system) via the existing pluggable Notifier interface. No new wiring. |

## 13. Phasing

Two substrate PRs, then five wiring PRs:

### PR1 -- substrate core (~1000 LOC + 50 tests)

- `WorkClaimAtom` type definition + lifecycle state union + attestation-result atom types.
- `src/substrate/claim-contract.ts`: `dispatchSubAgent`, `markClaimComplete`, `ClaimHandle`, claim-secret-token helpers (generate + rotate + constant-time compare), verification dispatcher.
- `src/substrate/claim-verifiers/`: `pr.ts`, `plan.ts`, `task.ts`, `research-atom.ts` + `index.ts` registry.
- `src/runtime/loop/claim-reaper.ts`: `runClaimReaperTick`, `detectStalledClaims`, `drainStalledQueue`, `recoverStalledClaim`.
- PreToolUse hook updates: reject `AtomStore.put` of `claim-attestation-*` atoms from non-substrate principals.
- `bootstrap/canon/pol-claim-budget-tier-{default,raised,max}.json`.
- `bootstrap/canon/pol-claim-reaper-cadence-ms.json`, `pol-claim-recovery-max-attempts.json`, `pol-claim-recovery-deadline-extension-ms.json`, `pol-claim-attesting-grace-ms.json`, `pol-claim-pending-grace-ms.json`, `pol-claim-verifier-timeout-ms.json`, `pol-claim-verifier-failure-cap.json`, `pol-claim-session-post-finalize-grace-ms.json`.
- `bootstrap/bootstrap-claim-contract-canon.mjs` script.
- Default redactor pattern updates: regex match for `claim_secret_token:` + the token format (43+ char base64url).
- Tests (50+, see Section 16).
- **Critical:** sub-agents NOT yet using the new API. Legacy direct-dispatch paths continue to work. This PR is pure addition.

### PR2 -- LoopRunner wiring (~150 LOC + 8 tests)

- Wire `runClaimReaperTick` into `LoopRunner.tick()` alongside `runReaperSweep`.
- `bootstrap/canon/pol-loop-pass-claim-reaper-default.json` -- default-on dial per `dev-loop-pass-defaults-via-canon`.
- CLI flag `--claim-reaper` (canon-default ON, CLI override).
- Tests: tick ordering, Phase A/Phase B decoupling, STOP halting both reapers, canon-default ON, CLI override path.

### PR3 -- pr-fix-actor migration (~250 LOC + 10 tests)

- Replace direct Agent-tool dispatch in `PrFixActor.apply` with `dispatchSubAgent`.
- Wire `markClaimComplete` into the sub-agent's exit path via the existing `pr-fix-observation` atom write.
- Update `run-pr-fix.mjs` driver to thread `caller_principal_id` + accept the returned `claim_secret_token`.
- Tests: full pr-fix flow with claim-contract, token-mismatch rejection, principal-mismatch rejection, post-complete rejection, recovery via PR6 resume strategy, recovery with rotated token.
- **Highest-leverage principal** -- covers today's failure pattern directly.

### PR4-7 -- other principal migrations

One PR per principal, each ~150 LOC + 6 tests, uniform pattern:

- PR4: code-author
- PR5: cto-actor
- PR6: cpo-actor
- PR7: brainstorm-actor

Each follows the same wiring pattern PR3 establishes. The substrate is identical; only the principal-specific brief composition differs.

### Sequencing

PR1 and PR2 can land in either order, but PR2 depends on PR1's `runClaimReaperTick` export. PR3 depends on PR1's contract layer + PR2's LoopRunner wiring. PR4-7 each depend on PR3 (for the migration pattern) but are independent of each other and can land in parallel.

### Until-migrated posture

Between PR2 (substrate live) and PR7 (last principal migrated), non-migrated principals dispatch via the legacy direct-Agent-tool path AND do not write `work-claim` atoms. The reaper queries `type: "work-claim"` claims; the reaper sees nothing from non-migrated principals and cannot fire false stalls on them. The migration is opt-in per principal.

## 14. Alternatives rejected

### Q1 alternatives

- **(a) Work-item terminal-state contract alone.** Strongest contract; the agent has nowhere to wander to. Rejected because today's evidence is that ANY contract gets violated; without a fallback, every violation cascades. Discipline + fallback beats discipline alone.
- **(b) Artifact handoff alone.** Sub-agent produces the artifact and substrate drives to terminal. Rejected because the substrate driver becomes a new failure surface (what if it crashes mid-drive?). Layering keeps the original sub-agent accountable AND has the substrate as floor.

### Q2 alternatives

- **(1) PR number as the only handle.** Cheapest. Rejected because 1/3 of today's failures were pre-PR (Task #311 sub-agent stalled before opening a PR). A handle that only covers PRs misses real failure cases.
- **(2) Plan-id as the handle.** Tightly couples this to the planning pipeline. Rejected because sub-agents dispatch for research, canon-scouting, audits -- not just plans. The handle must generalize.

### Q3 alternatives

- **(a) Substrate-observed only (sub-agent never attests).** Purest enforcement. Rejected because it loses the audit signal of "agent thought it was done, here's what it checked" -- that signal is gold for debugging future drift and for canon-grade learning. Enterprise systems want the rich audit, not just the gate.
- **(c) Sub-agent reports, no verification.** Just renames the current failure mode with a new atom type. Rejected as a non-fix.

### Q4 alternatives

- **(a) Fresh re-spawn only.** Cheapest. Rejected because it discards prior reasoning; the recovered agent has to re-learn everything the original one knew. Operator's "maximize work and effort and knowledge" framing argues for resume-first.
- **(b) Resume-by-default (no fresh fallback).** Rejected because resume can genuinely fail (blob shipped, model context overflow, stale beyond ttl). Without the fresh fallback, those cases escalate immediately on attempt #1, which violates "minimize errors."

### Q5 alternatives

- **(a) Uncapped per claim.** Solves "budget = never the failure cause" cleanly but is too sharp for indie (unbounded API bill) and unpredictable for org (one runaway claim chews 50-actor budget allocation).
- **(c) Adaptive budget tied to claim progress.** Smarter targeting but adds progress-signal definition + observer wiring. YAGNI vs (b) -- only worth shipping if ladder proves insufficient.
- **(d) Budget by expected-terminal-state.** Sensible but requires claim-typing which isn't otherwise needed. Coupling claim-typing and budget would inflate the spec surface. Deferred to a future spec if observed-need emerges.

### Architecture-shape alternatives

- **Approach 1 -- Vertical slice on pr-fix-actor.** Build the full system for one principal first. Rejected because it creates one-principal-shaped substrate code that's hard to generalize cleanly when the second principal adopts. Substrate-purity discipline argues for mechanism-first.
- **Approach 3 -- Reaper-first quick-win.** Ship a minimal open-PR reaper as PR1 to address today's pain immediately. Rejected because the quick-win ships behavior we'd refactor in PR2; "ship the right fix the first time" argues against the false economy.

### Other rejected designs

- **Process-side identity proof (v2 finding).** Considered: have the sub-agent's process send a signed handshake to the substrate before any attest call. Rejected because the sub-agent runs as a child process of the dispatching script; the process boundary is opaque. Token + principal check is the boundary that maps cleanly onto the existing trust model (`gh-as.mjs` / `git-as.mjs` already trust the script's principal assertion).
- **Per-claim STOP sentinel** (`.lag/STOP-CLAIM-<id>`). Multiplies operator cognitive load. The single global STOP plus future Console abandon-action (task #296) covers granular cases.
- **Hard-killing post-terminal sub-agents.** Substrate-side mid-process kill is the operator's STOP path; it is a medium-tier kill switch concern (canon D13). The substrate detects runaway behavior via post-terminal attest, writes the `principal-misbehavior` actor-message, and lets the operator act.
- **Synchronous Phase A + Phase B (single reaper pass).** Holding a claim-lock across adapter dispatch starves other claim transitions. Decoupled into two phases via `stalled` intermediate state.
- **Budget tier as a closed enum.** Would require a substrate code change to add a new tier. Rejected; tiers are policy.
- **New AtomStore caller-module capability primitive (v3 finding).** Considered for the threat-model row 11 ("direct write of `claim-attestation-*` by sub-agent principal"). Rejected because it requires a substantial new substrate primitive (every `AtomStore.put` call site would need to thread a capability), with low marginal benefit over the existing per-principal hook (which catches the routine case). Residual risk of in-process compromise is bounded by medium-tier kill switch + operator STOP. Spec'd as future work if the hook layer proves insufficient.
- **Token reused across recovery attempts (v3 finding).** Considered as simpler-than-rotation. Rejected because a zombie sub-agent from a prior attempt could race the recovered attempt with `caller_principal_id` matching (same principal across recoveries) and a still-valid token. Rotation closes the race for the cost of one `crypto.randomBytes(32)` per recovery.
- **Fixed deadline never extended on recovery (v3 finding).** Considered as simpler than extension. Rejected because the recovered claim would instantly re-stall on the next Phase A tick, consuming a `recovery_attempts` increment for no real work. Extension via canon-policy keeps the dial in canon.

## 15. What breaks if revisited

Per `dev-forward-thinking-no-regrets`:

In 3 months at 10x scale (50+ actors, 10x more canon, more external integrations), the substrate is still sound:

- The `work-claim` atom generalizes -- adding terraform-apply or slack-acked work-shapes is a new verifier file, not a substrate change.
- The reaper scales with `pol-claim-reaper-cadence-ms`; 15s cadence supports ~3,000 claims/min query throughput on the AtomStore (within current PR #197 race-fixed write throughput).
- The budget tier ladder is dial-by-canon; an org running 50 actors sets a single deployment-scoped policy atom and every actor inherits.
- The recovery layer composes cleanly with future actor types: every actor inherits the same dispatch contract, no per-actor recovery logic needed.
- The Phase A / Phase B decoupling supports event-source migration: Phase B can move to a Scheduler.NOTIFY-driven backend without changing Phase A or the contract layer.
- Token rotation is independent of `crypto` implementation -- swapping `crypto.randomBytes` for a hardware RNG seam is a one-line change in `src/substrate/claim-contract.ts`.

Regret modes:

- **If sub-agents become reliable on their own**, the reaper is mostly idle and the substrate is "insurance" we pay for in code complexity (~1000 LOC). Acceptable; the insurance has historically been needed (3/3 today).
- **If a future failure mode emerges that the verifier handlers can't catch** (e.g., the GitHub API itself reports incorrect state), the substrate's audit-trail still surfaces the divergence -- the system fails loudly to the operator rather than silently to wrong terminal state.
- **If budget tiers prove too coarse**, the adaptive-budget alternative (Q5c) can be added as a higher-priority canon-policy without changing substrate. The seam is preserved.
- **If `claim_secret_token` leaks via a redactor regression**, the principal-match check (Section 6 step 5) is a second gate; defense-in-depth holds even on token leak. A red-team test in PR1's test suite asserts that a token-only-without-principal attestation is rejected.
- **If the substrate's contract module itself is compromised**, all bets are off (Tier 1 compromise). The PreToolUse hook on `claim-attestation-*` writes is a gate against the routine sub-agent bypass, not against a substrate-module rewrite. Operator STOP + medium-tier kill switch are the operator's only response to a Tier 1 compromise.

## 16. Acceptance criteria for PR1

A passing PR1 must:

- Add the `work-claim` atom type to `src/atoms/types.ts` with a new lifecycle-state union and JSDoc documenting the lifecycle. JSDoc references mechanism only; no canon ids in JSDoc per `feedback_src_docs_mechanism_only_no_design_links`. Doc-prose elsewhere (this spec, design notes) may reference canon ids freely.
- Add `claim-attestation-accepted`, `claim-attestation-rejected`, `claim-stalled`, `claim-escalated` atom types.
- Provide `src/substrate/claim-contract.ts` with `dispatchSubAgent`, `markClaimComplete`, `ClaimHandle`, claim-secret-token helpers (generate, rotate, constant-time compare), and the verifier-dispatch entry point. All exports are mechanism-only (no principal names, no work-shape hardcoding, no canon ids in JSDoc).
- Provide four reference verifier handlers under `src/substrate/claim-verifiers/`: `pr.ts`, `plan.ts`, `task.ts`, `research-atom.ts`, plus an `index.ts` registry.
- Provide `src/runtime/loop/claim-reaper.ts` with `runClaimReaperTick`, `detectStalledClaims`, `drainStalledQueue`, `recoverStalledClaim`. Not yet wired into LoopRunner; that's PR2.
- PreToolUse hook updates: rejects `AtomStore.put` of any `claim-attestation-*` or `claim-stalled` or `claim-escalated` atom from a principal that is not the substrate's contract module's resolved principal (typically `apex-agent` or a designated substrate principal).
- Default redactor pattern updates: strip `claim_secret_token:\s*[A-Za-z0-9_-]{43,}` AND standalone 43+ char base64url strings from `llm_input` / `llm_output` / tool-call args before persistence.
- Provide `bootstrap/canon/pol-claim-budget-tier-{default,raised,max}.json`, `pol-claim-reaper-cadence-ms.json`, `pol-claim-recovery-max-attempts.json`, `pol-claim-recovery-deadline-extension-ms.json`, `pol-claim-attesting-grace-ms.json`, `pol-claim-pending-grace-ms.json`, `pol-claim-verifier-timeout-ms.json`, `pol-claim-verifier-failure-cap.json`, `pol-claim-session-post-finalize-grace-ms.json`.
- Provide `bootstrap/bootstrap-claim-contract-canon.mjs` script that seeds the above atoms on a fresh deployment.
- 50+ tests covering the categories below. Each category may expand to multiple test files; the count is the minimum aggregate across all categories.

  **Happy path:**
  - dispatch → executing → attesting → complete via verifier.ok=true.

  **Lifecycle transitions:**
  - all documented arrows in Section 5 lifecycle diagram (pending→executing, executing→attesting, attesting→executing on rejection, attesting→complete on accept, executing→stalled, attesting→stalled (grace expired), attesting→stalled (verifier-failure-cap exceeded), stalled→executing (recovery), stalled→abandoned (cap reached), pending→stalled).

  **Attestation rejection paths:**
  - each of the 10 `AttestationResult.reason` values (`stop-sentinel`, `claim-not-found`, `claim-already-terminal`, `token-mismatch`, `principal-mismatch`, `identifier-mismatch`, `kind-mismatch`, `ground-truth-mismatch`, `verifier-error`, `verifier-timeout`).

  **All 4 verifier handlers:**
  - with mocked ground truth, accept path AND ground-truth-mismatch path each.

  **Budget-tier resolution:**
  - default, raised, max, plus a custom-org tier (`"emergency"`).

  **STOP integration:**
  - `dispatchSubAgent` throws stop-sentinel-active when sentinel present.
  - `markClaimComplete` returns stop-sentinel AND writes audit rejection atom when sentinel present.
  - `runClaimReaperTick` halts at Phase A entry AND at Phase B entry when sentinel present.

  **Concurrent reaper lock:**
  - two reaper invocations race on the same claim; only one wins Phase A flip-to-stalled, only one wins Phase B recovery-step, the second sees version-conflict and skips cleanly.

  **Phase A / Phase B decoupling:**
  - Phase B dispatch on a slow adapter does not block Phase A from running its full scan on other claims.

  **Recovery paths:**
  - resume (with valid `walkAuthorSessions` hit).
  - resume-fallback-to-fresh (session unrecoverable).
  - fresh respawn at recovery_attempts=2.
  - escalation at N=3 (writes claim-escalated atom + Notifier message + flips claim to abandoned).

  **Pending-state stall recovery:**
  - claim flagged stalled while in `pending` recovers via fresh respawn (no resume path attempted).

  **Token rotation on recovery:**
  - recovered claim has a different `claim_secret_token` than its pre-recovery value.
  - zombie sub-agent attempting attest with the old token receives `token-mismatch` rejection.
  - the fresh sub-agent receives the new token in its recovery brief and successfully attests.

  **Deadline extension on recovery:**
  - recovered claim's `deadline_ts` is `max(original, now() + pol-claim-recovery-deadline-extension-ms)`.
  - Phase A `now > deadline_ts` condition does not fire on the immediate next tick after recovery.

  **Past-deadline at dispatch:**
  - `dispatchSubAgent` throws `deadline-already-past` when `brief.deadline_ts <= now()`.

  **Recovery brief size cap:**
  - diff > 4 KB spills to BlobStore via `host.blobStore.put`; brief > 16 KB inline also spills.
  - both verified via `host.blobStore.get` returning the full payload after spillage.

  **AtomStore policy enforcement:**
  - direct `AtomStore.put` of `claim-attestation-accepted` from a sub-agent principal is rejected at the hook layer.
  - same call from the substrate contract module's principal succeeds.

  **Redactor strips token:**
  - an `agent-turn` atom written by a sub-agent that echoes the token in `llm_input` has the token stripped before persistence.
  - both the `claim_secret_token:` labeled form AND a bare-token standalone form are stripped.

  **Post-complete attest:**
  - post-terminal attest call rejected with `claim-already-terminal` AND a `principal-misbehavior` actor-message written.

  **Verifier failure cap:**
  - 3 consecutive `verifier-timeout` rejections flip claim straight to `stalled` (bypassing grace clock).
  - `verifier_failure_count` resets to 0 on Phase B recovery dispatch.

  **Session-finalize debounce:**
  - claim in `executing` with `latest_session_finalized_at = now() - 10s` is NOT flagged stalled.
  - same claim with `latest_session_finalized_at = now() - 60s` (past 30s grace) IS flagged stalled.

- **Real-PR fixture e2e test.** Using a fake-GitHub fixture (existing `test/fixtures/github-mock.ts` shape), the test dispatches a real-shaped sub-agent against a stub PR atom, exercises the full attest cycle (dispatch → executing → attesting → verifier-call → complete), and asserts both the accepted path and the ground-truth-mismatch path produce the expected atom chain. Validates that the verifier registry wires correctly end-to-end.

- `npm run typecheck` and `npm run test` pass clean.
- Pre-push grep checklist (per `feedback_pre_push_grep_checklist`) shows no emdashes, no private terms, no design/ADR cross-refs in src/, no canon ids in src/ JSDoc (doc-prose ok).
- `node scripts/cr-precheck.mjs` reports 0 critical / 0 major findings before push.
- CR-clean after one round (target; up to 2 rounds acceptable).
- LAG-auditor + canon-compliance auditor sub-agent both approve.

## 17. Open questions / explicit future scope

- **Adaptive budget by progress signals (Q5c).** Defer until the ladder proves insufficient in practice; revisit after 30 days of substrate in production.
- **Per-claim STOP sentinel** (`.lag/STOP-CLAIM-<id>`). Defer until operator workflow demands granular stop; the existing global STOP covers safety today.
- **Claim-typing for budget-by-expected-terminal (Q5d).** Defer until ladder coverage gaps appear; the tier ladder is simpler and covers operator's stated need.
- **Multi-principal claim handoff.** Out of scope for this spec; a future spec covers cross-principal collaboration on the same work-item.
- **Console UI for the work-claim feed.** Follow-up PR after PR1+PR2 land; reads from AtomStore via existing `/api/atoms.find` endpoint with `type=work-claim` filter.
- **Reaper backend swap** (NOTIFY-driven vs polling). Future seam reserved; current polling is sufficient at indie + small-org scale. Org-ceiling deployments revisit when claim volume exceeds 1000/hour. Phase A / Phase B decoupling supports the migration.
- **Hard-kill of post-terminal runaway sub-agents.** Substrate-side mid-process kill is a medium-tier kill switch concern (canon D13). Today the substrate detects and surfaces; operator acts.
- **AtomStore caller-module capability primitive.** Considered for defense-in-depth against in-process forgery of `claim-attestation-*` atoms. Rejected for scope (Section 14); revisit if the per-principal hook layer proves insufficient in practice.

## References

### Canon directives applied

- `dev-sub-agent-pr-driver-responsibility` -- the foundational discipline this substrate enforces mechanically.
- `dev-substrate-not-prescription` -- substrate stays mechanism-only; policy in canon.
- `dev-indie-floor-org-ceiling` -- every design choice serves both ends.
- `dev-governance-before-autonomy` -- STOP sentinel + canon-policy first, automation dial second.
- `inv-l3-requires-human` -- canon-policy edits (budget tier, recovery max, cadence) remain operator-signed.
- `inv-kill-switch-first` -- STOP integration at every substrate entry point.
- `arch-atomstore-source-of-truth` -- AtomStore is the single source of truth for claim state.
- `dev-extreme-rigor-and-research` -- alternatives_rejected populated for every decision.
- `dev-forward-thinking-no-regrets` -- Section 15 articulates 3-month review.
- `dev-attribution-hooks-cover-all-tool-paths` -- AtomStore write-time policy fits the existing hook-enforcement model.
- `feedback_claude_cli_subscription_cost_model` -- budget tier default sizing rationale.
- `feedback_src_docs_mechanism_only_no_design_links` -- JSDoc fence on canon ids.

### Prior PRs informing this design

- PR #166 -- Agent-loop substrate (4 seams + 2 atom types + 2 policies + projection).
- PR #170 -- PrFixActor: the first actor with explicit observe → classify → propose → apply → reflect lifecycle that this substrate generalizes.
- PR #171 -- ResumeAuthorAgentLoopAdapter: the substrate the recovery layer reuses.
- PR #172 -- cr-precheck capability: the pre-push gate every PR honors.
- PR #197 -- AtomStore.put TOCTOU race fix: the foundation the concurrent-reaper-lock relies on.
- PR #389 -- pr-observation refresh canon-policy: the pattern the budget-tier policies follow.

### Substrate seams reserved

- Reaper backend (polling vs NOTIFY-driven). Phase A / Phase B decoupling supports migration.
- Verifier handler registry (open for extension).
- Budget tier set (open-extensible via canon policy).
- Notifier channel (operator-tunable).
- Redactor patterns (open for extension; defaults strip claim secret tokens).
- AtomStore caller-module capability (future, if hook layer proves insufficient).
