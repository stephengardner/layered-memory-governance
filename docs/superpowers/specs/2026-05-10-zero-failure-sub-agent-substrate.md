# Zero-Failure Sub-Agent Substrate

**Date:** 2026-05-10
**Status:** Spec, awaiting operator review
**Provenance:** Operator-driven brainstorming session 2026-05-10, decisions Q1-Q5 captured below.

---

## 0. Frame

Operator directive (verbatim, 2026-05-10):

> "the real answer is to make sure that we increase budgets or do literalyl WEHATEVER we have to do to ensure nothing EVER fails"
>
> "spec it for fix as soon as possible, these are fundamental things we need to fix. What we want is an enterprise product that ships code and truly minimizes errors, and maximizes the work and the effort and the knowledge such that it ships the right fix the first time"

Observed failure pattern (3/3 sub-agent dispatches today, 2026-05-10):

- Sub-agent for Task #311 (operator-action audit-trail dashboard): stalled mid-flight; parent took over.
- Sub-agent for Task #294 (agent-turn streaming): completed work but exited before push; parent pushed.
- Sub-agent `acf1e48767993b0fd` for Task #329: completed all commits, exited before pushing PR #389; parent pushed. (Side note: this sub-agent then RECOVERED itself for PR #390, so the behavior is bimodal — sometimes sub-agents do drive to terminal cleanly, sometimes they don't.)

Canon `dev-sub-agent-pr-driver-responsibility` already says "the sub-agent owns the PR through MERGED, parent re-dispatches on orphan-after-5min." The discipline is encoded. The 3/3 violations today show the discipline is not enforced at the substrate level; without enforcement, future agents will continue to violate it.

The operator's framing — "ship the right fix the first time," "minimize errors," "enterprise product" — argues for substrate-level enforcement rather than stronger doctrine.

---

## 1. Goals

1. **Substrate-enforced terminal-state contract.** A sub-agent cannot exit with `terminal-success` while its assigned work is in a non-terminal state. The contract is checked by substrate code, not by discipline alone.
2. **Defense-in-depth recovery.** When (and only when) the contract is violated, substrate auto-recovers via a bounded tiered ladder (resume → fresh-spawn → escalate).
3. **Budget cannot be the failure reason.** Each claim has a tiered budget ladder; on each recovery attempt, the substrate auto-promotes to the next tier. Solo-developer indie-floor stays bounded; org-ceiling dials the max via canon edit.
4. **Universal work-item handle.** A single `work-claim` atom type generalizes across PR-driving, plan-driving, task-driving, and research dispatches. Adding a new work-shape only requires a new verification handler, not a new substrate primitive.
5. **Full audit chain.** Every claim, attestation (accepted or rejected), recovery attempt, and escalation lands as an atom with `provenance.derived_from` chaining back to the seed intent.

## 2. Non-Goals

- **Making bad code automatically good.** Sub-agent output quality is orthogonal to terminal-state enforcement; this spec addresses *did the agent finish what it was given*, not *did it do it well*. Code quality remains the responsibility of CR + LAG-auditor + cr-precheck.
- **Removing operator gates on canon writes.** L3 canon promotion remains operator-signed per `inv-l3-requires-human`. The budget ladder dial is itself a canon edit; raising or lowering it produces an audit-trailed decision atom.
- **Auto-merging without operator approval.** Merge authority stays with the operator (or lag-cto under medium-tier kill switch, per canon `dec-autonomous-merge-endgame`). A `work-claim` reaching `complete` state means the work-item is in its expected terminal — which for PRs is MERGED, the merge having been performed by the authorized actor, not by the substrate.
- **Cross-agent claim handoff.** A claim is dispatched to one principal; if recovery moves it to a different principal, that's a new claim (new id, `parent_claim_id` link). This spec does not introduce multi-principal claim semantics.

## 3. Decisions captured

The brainstorming session settled five foundational questions before the design was written:

| Q   | Question                                  | Decision | Rationale                                                                                                                                                                                                       |
| --- | ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Contract shape                            | (c) layered: contract + reaper | A contract without a fallback is just discipline (which already failed 3/3 times today). Contract first to catch the cheap 95%; reaper as the floor for the residual 5%.                                       |
| Q2  | Work-item handle                          | (3) new `work-claim` atom | Generalizes across PR-driving + pre-PR (e.g. research) + post-PR cases. PR-only handle would miss 1/3 of today's failures.                                                                                       |
| Q3  | Completion semantics                      | (b) sub-agent attests + substrate verifies | Preserves audit chain ("agent thought it was done, here's what they checked") while making substrate the final word. Pure substrate-observed would lose the rich audit signal.                                  |
| Q4  | Recovery action                           | (c) tiered: resume → fresh → escalate (N=3) | Resume-first preserves knowledge per "maximize work and effort." Bounded recursion prevents resource burn on broken claims. Escalation is the audit-trail terminus.                                              |
| Q5  | Budget posture                            | (b) tiered budget ladder | Substrate auto-raises tier on each recovery; directly executes "increase budgets." Default tier sized for typical PR-fix burn; max tier is the operator-dialed ceiling. Indie zero-config, org-dialable via canon. |

Architecture phasing chosen: **Approach 2 (foundational substrate first)** — ship substrate primitives in 1-2 PRs with zero principal-specific wiring, then migrate each of the 5 principals in follow-up PRs.

## 4. Architecture

The substrate adds three components plus one new atom type. The existing Host interface is unchanged.

```text
Existing                          New
────────                          ───
AtomStore                         work-claim atom type
PrincipalStore                    (lifecycle states, schema)
LLM                               
Notifier                          dispatchSubAgent(brief, expected_terminal)
Scheduler          ───────►       └─► writes work-claim atom (state=pending)
Auditor                           └─► invokes existing AgentLoopAdapter
CanonStore                        └─► returns ClaimHandle
Clock                             
                                  markClaimComplete(claim_id, attestation)
                                  └─► verifyTerminal(kind, identifier, expected_states)
                                  └─► writes claim-attestation-{accepted,rejected}
                                  
                                  runClaimReaperTick(host)
                                  └─► queries open work-claims
                                  └─► flags stalled, dispatches tiered recovery
```

**File layout:**

- `src/atoms/types.ts`                          — additive: `WorkClaimAtom` shape + `claim_state` union + `BudgetTier` union.
- `src/substrate/claim-contract.ts`             — new: `dispatchSubAgent`, `markClaimComplete`, `ClaimHandle`, verification dispatcher.
- `src/substrate/claim-verifiers/`              — new: verification handlers, one per `terminal_kind`. Each handler reads ground truth (GitHub API for `pr`, AtomStore for `plan`, etc.) and returns `{ ok, observed_state }`.
- `src/runtime/loop/claim-reaper.ts`            — new: `runClaimReaperTick(host)`, `recoverStalledClaim(claim)`.
- `bootstrap/canon/pol-claim-budget-tier-*.json` — three canon policy atoms (default / raised / max).
- `bootstrap/canon/pol-claim-reaper-cadence-ms.json` — reaper cadence dial.
- `bootstrap/canon/pol-claim-recovery-max-attempts.json` — N=3 recovery cap dial.
- `bootstrap/bootstrap-claim-contract-canon.mjs` — one-shot operator script to seed the canon atoms.

**What stays the same:**

- 8 Host sub-interfaces. No new Host method.
- Existing `AgentLoopAdapter` interface. The claim-contract layer wraps it without changing it; legacy direct-dispatch paths continue to work.
- The 5 stage adapters + 5 actor principals. They adopt the contract in follow-up PRs (PR3-7).
- The existing reaper (`runReaperSweep` for stale plans/pipelines) keeps running unchanged. The claim reaper is an additional, parallel tick.

**Substrate purity audit (per `dev-substrate-not-prescription` + `dev-indie-floor-org-ceiling`):**

`src/substrate/claim-contract.ts` is mechanism-only. No principal names, no work-shape assumptions, no hardcoded budget values. The verifier dispatcher reads `terminal_kind` from the atom and dispatches to the matching handler — adding a new work-shape only adds a new file in `src/substrate/claim-verifiers/`, never changes the contract layer. `runClaimReaperTick` reads cadence + recovery max + budget tiers from canon-policy atoms; no constants in the runtime path.

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
      claim_id: string;       // == atom.id, denormalized for lookup
      dispatched_principal_id: string;   // the sub-agent's principal
      brief: {
        prompt: string;
        expected_terminal: {
          kind: "pr" | "plan" | "task" | "research-atom";
          identifier: string;             // pr number | plan id | task id | atom id
          terminal_states: string[];      // e.g. ["MERGED"] for pr
        };
        deadline_ts: string;              // ISO-8601 UTC
      };
      claim_state:
        | "pending"
        | "executing"
        | "attesting"
        | "complete"
        | "stalled"
        | "abandoned";
      budget_tier: "default" | "raised" | "max";
      recovery_attempts: number;          // 0 on initial dispatch
      parent_claim_id: string | null;     // for nested dispatches
      session_atom_ids: string[];         // agent-session atoms produced by attempts
    };
  };
}
```

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
                                   │                            │
                                   │                  accepted? ├──── yes ───▶ ┌──────────┐
                                   │                            │              │ complete │
                                   │                            │              └──────────┘
                                   │                            │
                                   │                  rejected  │
                                   │                            ▼
                                   │                     (back to executing on retry,
                                   │                      reaper sees no progress)
                                   │
                            reaper detects stall
                                   │
                                   ▼
                              ┌──────────┐
                              │ stalled  │
                              └──────────┘
                                   │
                       recoverStalledClaim
                                   │
                  ┌────────────────┼──────────────────────┐
                  │                │                      │
        attempts < max         attempts < max     attempts >= max
        + resume avail         + resume unavail
                  │                │                      │
                  ▼                ▼                      ▼
            resume retry      fresh respawn         ┌────────────┐
            (executing)       (executing)           │ abandoned  │
                                                    └────────────┘
                                                    + escalation atom
                                                    + Notifier message
```

### Adding a new terminal kind

To support a new work-shape (e.g. `git-tag-push`), the only additions are:

1. Add `"git-tag-push"` to the `kind` union in `WorkClaimAtom.metadata.work_claim.brief.expected_terminal.kind`.
2. Add `src/substrate/claim-verifiers/git-tag-push.ts` exporting `verifyGitTagPushTerminal(identifier: string, expected_states: string[]): Promise<{ ok: boolean; observed_state: string }>`.
3. Register the verifier in `src/substrate/claim-verifiers/index.ts`.

No changes to the contract layer, the reaper, the recovery logic, or any actor.

## 6. Dispatch + attest contract

Two new substrate functions in `src/substrate/claim-contract.ts`.

### `dispatchSubAgent`

```ts
export interface DispatchSubAgentInput {
  brief: WorkClaimBrief;
  budget_tier?: BudgetTier;          // default: "default"
  parent_claim_id?: string | null;   // for nested dispatches
  agent_loop_adapter: AgentLoopAdapter;  // injected
}

export interface DispatchSubAgentOutput {
  claim_id: string;
  claim_handle: ClaimHandle;
}

export interface ClaimHandle {
  /**
   * Resolves when the claim reaches a terminal state (complete or abandoned).
   * Long-running; callers may abandon the promise and rely on the reaper to drive.
   */
  settled(): Promise<{ final_state: "complete" | "abandoned"; reason?: string }>;
  /**
   * Current snapshot of the claim atom; reads from AtomStore.
   */
  read(): Promise<WorkClaimAtom>;
}

export async function dispatchSubAgent(
  input: DispatchSubAgentInput,
  host: Host
): Promise<DispatchSubAgentOutput>;
```

Behavior:

1. Validates `brief.expected_terminal.kind` is registered (verifier exists).
2. Resolves `budget_tier` to a max-USD via canon policy (`pol-claim-budget-tier-{tier}`); fails closed if the tier is missing.
3. Writes the `work-claim` atom with `claim_state="pending"` + the resolved budget cap embedded.
4. Invokes the injected `AgentLoopAdapter` with the brief prompt + a `WORK_CLAIM_CONTEXT` block appended to the prompt: `claim_id`, `expected_terminal`, contract reminder ("call markClaimComplete before exit").
5. Transitions claim to `executing` immediately after adapter dispatch initiates.
6. Returns the `claim_handle` synchronously; caller may `await handle.settled()` or proceed and let the reaper drive.

### `markClaimComplete`

```ts
export interface AttestationInput {
  terminal_kind: "pr" | "plan" | "task" | "research-atom";
  terminal_identifier: string;
  observed_state: string;            // what the sub-agent saw
}

export interface AttestationResult {
  accepted: boolean;
  reason?: string;                    // present when rejected
  observed_state?: string;             // what the substrate saw, if rejected
}

export async function markClaimComplete(
  claim_id: string,
  attestation: AttestationInput,
  host: Host
): Promise<AttestationResult>;
```

Behavior:

1. Reads the `work-claim` atom; rejects with `claim-not-found` if absent or not in `executing`/`attesting`.
2. Transitions claim to `attesting`.
3. Validates `attestation.terminal_identifier === claim.brief.expected_terminal.identifier`. If mismatch → write `claim-attestation-rejected` atom + return `{ accepted: false, reason: "identifier-mismatch" }`. Claim stays in `attesting`.
4. Validates `attestation.terminal_kind === claim.brief.expected_terminal.kind`. If mismatch → write `claim-attestation-rejected` + return `{ accepted: false, reason: "kind-mismatch" }`.
5. Calls the registered verifier for `terminal_kind` against the live ground-truth source. If the verifier returns `{ ok: false, observed_state: "..." }` → write `claim-attestation-rejected` with the divergence detail; return `{ accepted: false, reason: "ground-truth-mismatch", observed_state }`.
6. On `{ ok: true }` → write `claim-attestation-accepted` atom, flip claim to `complete`, return `{ accepted: true }`.

### Contract surface to sub-agent

Every dispatched brief is prepended with this block, generated by the contract layer:

```text
═══════════════════════════════════════════════════════════════════════
WORK CLAIM CONTEXT (substrate-enforced, do not paraphrase)
═══════════════════════════════════════════════════════════════════════
claim_id:            work-claim-<uuid>
expected_terminal:   { kind: "pr", identifier: "<N>", terminal_states: ["MERGED"] }
deadline:            <ISO-8601>
budget:              $<USD>

Before exit, you MUST call markClaimComplete({
  claim_id,
  attestation: {
    terminal_kind: "<kind>",
    terminal_identifier: "<id>",
    observed_state: "<what you observed via ground truth>"
  }
})

Substrate verifies your attestation against ground truth (e.g. GitHub
API for PR state). Mismatch is a loud rejection; the claim stays open
and the reaper will recover. Your terminal-success report is advisory
until the substrate accepts your attestation.

If you cannot reach the expected terminal state, do NOT call
markClaimComplete. Exit, and the reaper will determine next steps.
═══════════════════════════════════════════════════════════════════════
```

## 7. Claim reaper

`runClaimReaperTick(host)` in `src/runtime/loop/claim-reaper.ts`, called from `LoopRunner` alongside `runReaperSweep`.

Per tick:

1. **STOP check.** If `.lag/STOP` is active → return `{ halted: true }` immediately. No queries, no transitions.
2. **Query open claims.** `AtomStore.find({ type: "work-claim", "metadata.work_claim.claim_state": ["pending", "executing", "attesting"] })`.
3. **For each claim, check stalled conditions:**
   - `host.clock.now() > parseISO(brief.deadline_ts)`, OR
   - `claim_state === "executing"` AND no in-flight `agent-session` atom whose `id` is in `claim.session_atom_ids` is still active (all sessions have `terminal_state` set), OR
   - `claim_state === "attesting"` AND most recent `claim-attestation-rejected` is older than `pol-claim-attesting-grace-ms` (default 5min) with no subsequent attest call.
4. **Flag stalled.** Write a `claim-stalled` atom (state-transition record), flip the claim's `claim_state` to `stalled`.
5. **Dispatch recovery.** Invoke `recoverStalledClaim(claim, host)`.

Cadence read from `pol-claim-reaper-cadence-ms` (default 60_000 ms = 1 minute). Tight enough that orphan-detection is bounded to ~1 minute; loose enough that an indie deployment doesn't burn CPU. Org-ceiling can dial to 15_000 ms for sub-15s SLA.

Concurrency: the reaper is wrapped by an atom-level claim lock (using `AtomStore.put` with optimistic version check) to prevent a concurrent reaper tick from flipping the same claim twice.

## 8. Tiered recovery

`recoverStalledClaim(claim, host)`:

1. **Cap check.** Read `pol-claim-recovery-max-attempts` (default 3). If `claim.recovery_attempts >= max_attempts`:
   - Write `claim-escalated` atom with the failure reason + a snapshot of all `session_atom_ids`.
   - `host.notifier.telegraph` a `claim-stuck` actor-message atom to the operator.
   - Flip claim_state to `abandoned`.
   - Return.

2. **Resume attempt (attempts === 0).** Look up the last `agent-session` in `claim.session_atom_ids`. Hand its `resumable_session_id` to the substrate's `ResumeAuthorAgentLoopAdapter` (PR6, merged 2026-04-25). If `walkAuthorSessions(host).find(s => s.session_id === resumable_session_id)` returns null (session unrecoverable: blob shipped, model context overflow, stale beyond 8h per pol-resume-strategy-pr-fix-actor) → fall through to fresh respawn.

3. **Fresh respawn.** Compose a recovery brief:
   ```
   Previous attempt stalled at [claim_state] after [N] attempts.
   Original brief: [original prompt]
   Last 5 agent-turn entries: [...]
   Diff so far on the work branch: [git diff]
   Expected terminal: [expected_terminal]
   Proceed to the expected terminal.
   ```
   Bump `budget_tier` per the ladder (`default → raised → max`); promote to `raised` on first recovery, `max` on second.
   Invoke `dispatchSubAgent` with the recovery brief; the new attempt's `claim_id` is the SAME claim_id (claim is shared; only `recovery_attempts` increments). Append the new `session_atom_id` to the existing claim's `session_atom_ids` array.

4. **State transition.** Increment `recovery_attempts`, flip `claim_state` back to `executing`, write a `claim-recovery-attempted` atom recording which strategy (resume vs fresh) and which tier.

The bounded recursion is the only termination guarantee. Without `pol-claim-recovery-max-attempts`, a fundamentally broken claim would consume budget forever.

## 9. Tiered budget ladder

Three canon policy atoms shipped via `bootstrap/canon/`:

```jsonc
// bootstrap/canon/pol-claim-budget-tier-default.json
{
  "id": "pol-claim-budget-tier-default",
  "type": "policy",
  "layer": "L3",
  "principal_id": "apex-agent",
  "content": "Default budget tier for sub-agent claims. Indie-floor sizing.",
  "confidence": 1.0,
  "provenance": { ... },
  "metadata": {
    "policy": {
      "kind": "claim-budget-tier",
      "tier": "default",
      "max_budget_usd": 0.50
    }
  }
}
```

```jsonc
// bootstrap/canon/pol-claim-budget-tier-raised.json
{ ..., "tier": "raised", "max_budget_usd": 2.00 }
```

```jsonc
// bootstrap/canon/pol-claim-budget-tier-max.json
{ ..., "tier": "max", "max_budget_usd": 10.00 }
```

Substrate resolves `claim.budget_tier` to the matching atom's `max_budget_usd` at `dispatchSubAgent` time and on every `recoverStalledClaim` invocation. The resolved value is threaded into the `AgentLoopAdapter`'s budget cap.

**Indie-floor zero-config:** `default=$0.50` matches today's `--max-budget-usd` default. A solo developer running LAG never has to know these dials exist; the substrate ships with sensible bounded values.

**Org-ceiling dial path:** an org-ceiling deployment writes a higher-priority atom with a deployment-scoped principal_id (`org-budget-policy` etc.) and updated values. The arbitration stack resolves the higher-priority atom at canon-read time. Per `dev-substrate-not-prescription`: raise the dial via canon edit, never in src/.

**No new substrate primitive.** The budget tier layer reuses the existing `pol-budget-cap` policy-atom shape and the existing `AgentLoopAdapter.budget` parameter. The only addition is the *tiered* resolution at the `dispatchSubAgent` and `recoverStalledClaim` boundaries.

## 10. Kill-switch integration

`inv-kill-switch-first` is load-bearing throughout. The `.lag/STOP` sentinel halts the reaper at the top of every tick:

```ts
export async function runClaimReaperTick(host: Host): Promise<TickResult> {
  if (await isStopSentinelActive(host)) {
    return { halted: true, reason: "stop-sentinel" };
  }
  // ... query, detect, recover
}
```

In-flight `recoverStalledClaim` calls finish their atom writes (we don't want to leave half-written atoms). No NEW recovery attempts fire while STOP is present. Active claims sit in their current state — `executing`, `attesting`, `stalled` — until STOP is cleared. The operator inspects post-mortem.

The `dispatchSubAgent` function also checks STOP at the top:

```ts
export async function dispatchSubAgent(input, host): Promise<...> {
  if (await isStopSentinelActive(host)) {
    throw new SubstrateError("stop-sentinel-active");
  }
  // ... write claim, invoke adapter
}
```

A sub-agent that's already running when STOP is set continues to its own next tick (we don't kill mid-LLM-call), but cannot be re-dispatched.

## 11. Threat model

The substrate adds new attack surfaces. Each is handled.

| Threat                                              | Mitigation                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised sub-agent always attests "complete"     | Substrate validates `attestation` against ground truth (GitHub API for PR state, AtomStore for plan_state, etc.). The sub-agent has no path to flip the work-item itself; it can only attest about what it sees, and substrate cross-checks. Verifier signing the wrong ground truth would require a separate compromise. |
| Runaway recovery (infinite N)                       | `pol-claim-recovery-max-attempts` (default 3) is a hard cap. Beyond it, the claim escalates and is abandoned. The cap atom is L3; modifying it requires operator signature.                                                                                                                                       |
| Canon-edit attack lowering budget tier              | Budget tier atoms are L3 + operator-signed; arbitration prefers operator-signed atoms via depth-tiebreaker; lowering the tier is itself an auditable canon-edit moment.                                                                                                                                            |
| Session-resume from a hostile blob                  | Existing PR6 `BlobShippedSessionResumeStrategy` guards apply: default-deny construction, required redactor, destination guard, CLI-version pin. The claim-recovery layer inherits these without reimplementing.                                                                                                    |
| Reaper running on a forked or partial atom store    | The reaper reads only atoms it itself has written or descended from the operator-signed canon. The verifier handlers query ground truth from external sources (GitHub, etc.) authenticated via bot-identity wrappers, not from the atom store. A partial atom store cannot fake a "PR is MERGED" verification.    |
| Concurrent reaper ticks transitioning same claim    | Atom-level optimistic version check on `AtomStore.put`. If two reaper invocations race, one's `put` fails the version check and aborts; the second's transition is the canonical one. Per the `arch-atomstore-source-of-truth` decision (PR #197 race fix).                                                       |
| Sub-agent calls `markClaimComplete` for an atom it doesn't own | The contract layer reads the `work-claim` atom; if the calling principal is not the `dispatched_principal_id`, the attestation is rejected with `principal-mismatch`. (Implementation: contract layer requires the caller to pass its identity, which the AgentLoopAdapter populates from the dispatching principal.) |
| Sub-agent never calls `markClaimComplete` and exits | Reaper detects the stalled claim (no in-flight session, deadline not yet, all sessions terminal) and initiates recovery. This is the primary failure mode the substrate is designed to handle.                                                                                                                    |

## 12. Indie-floor vs org-ceiling

Per `dev-indie-floor-org-ceiling`, every design decision must articulate how it serves both ends:

| Concern                              | Indie-floor (zero-config)                                                                                                                                | Org-ceiling (50+ actors)                                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget tiers                         | default=$0.50, raised=$2, max=$10. Solo developer's first sub-agent never knows the tiers exist; the defaults cover normal PR-fix work.                | Deployment-scoped policy atoms set max=$50 or higher. Tier promotion is automatic; cost is predictable because every claim has a known ceiling.                                                                                                                                  |
| Reaper cadence                       | 60s default. Idle CPU is negligible.                                                                                                                     | 15s for tight SLA; or remove the polling and event-source-drive via Scheduler.NOTIFY (future seam reserved, not built).                                                                                                                                                            |
| Recovery max attempts                | 3. After 3 attempts, escalate to operator. Solo developer gets a Notifier ping; not blocked.                                                            | Same default; org may dial to 5 for high-noise environments, or to 1 for low-tolerance environments where stalls are rare.                                                                                                                                                       |
| Resume path                          | PR6 `SameMachineCliResumeStrategy` (same-host, 8h staleness window). Always available for indie running on a single host.                              | Same plus opt-in `BlobShippedSessionResumeStrategy` (PR6) for multi-host org deployments. Default-deny opt-in per existing PR6 fence.                                                                                                                                            |
| Verifier handlers                    | Default handlers for `pr` (GitHub), `plan` (AtomStore), `task` (TaskList), `research-atom` (AtomStore). Cover the 4 work-shapes LAG ships today.        | Custom verifier handlers for proprietary work-shapes (e.g., `terraform-apply-completed`, `slack-message-acked`). Added under `src/substrate/claim-verifiers/<name>.ts` + registered in the index; no contract-layer change.                                                          |
| STOP sentinel                        | Already operator-known. No new operator concept.                                                                                                          | Same. No multi-tier STOP needed at this layer.                                                                                                                                                                                                                                   |
| Notifier escalations                 | Single channel (Telegram or file queue). Operator gets the `claim-stuck` ping.                                                                            | Org-channel (Slack escalation, paging system) via the existing pluggable Notifier interface. No new wiring.                                                                                                                                                                       |

## 13. Phasing

Two substrate PRs, then five wiring PRs:

### PR1 — substrate core (~700 LOC + 30 tests)

- `WorkClaimAtom` type definition + lifecycle state union.
- `src/substrate/claim-contract.ts`: `dispatchSubAgent`, `markClaimComplete`, `ClaimHandle`, verification dispatcher.
- `src/substrate/claim-verifiers/`: `pr.ts`, `plan.ts`, `task.ts`, `research-atom.ts` + `index.ts` registry.
- `src/runtime/loop/claim-reaper.ts`: `runClaimReaperTick`, `recoverStalledClaim`.
- `bootstrap/canon/pol-claim-*.json` + bootstrap script.
- Tests: lifecycle paths (pending→executing→attesting→complete), recovery (resume + fresh + escalation), budget-tier resolution, STOP integration, concurrent-reaper race, verifier-mismatch rejection, contract surface (sub-agent brief prepend).
- **Critical:** sub-agents NOT yet using the new API. Legacy direct-dispatch paths continue to work. This PR is pure addition.

### PR2 — LoopRunner wiring (~150 LOC + 5 tests)

- Wire `runClaimReaperTick` into `LoopRunner.tick()` alongside `runReaperSweep`.
- CLI flag `--claim-reaper` (default ON via canon policy `pol-loop-pass-claim-reaper-default`).
- Tests: tick ordering, STOP halting both reapers, default ON.

### PR3 — pr-fix-actor migration (~200 LOC + 8 tests)

- Replace direct Agent-tool dispatch in `PrFixActor.apply` with `dispatchSubAgent`.
- Wire `markClaimComplete` into the sub-agent's exit path via the existing `pr-fix-observation` atom write.
- Tests: full pr-fix flow with claim-contract, attestation-mismatch rejection, recovery via PR6 resume strategy.
- **Highest-leverage principal** — covers today's failure pattern directly.

### PR4-7 — other principal migrations

One PR per principal, each ~150 LOC + 5 tests, uniform pattern:

- PR4: code-author
- PR5: cto-actor
- PR6: cpo-actor
- PR7: brainstorm-actor

Each follows the same wiring pattern PR3 establishes. The substrate is identical; only the principal-specific brief composition differs.

### Sequencing

PR1 and PR2 can land in either order, but PR2 depends on PR1's `runClaimReaperTick` export. PR3 depends on PR1's contract layer + PR2's LoopRunner wiring. PR4-7 each depend on PR3 (for the migration pattern) but are independent of each other and can land in parallel.

## 14. Alternatives rejected

### Q1 alternatives

- **(a) Work-item terminal-state contract alone.** Strongest contract; the agent has nowhere to wander to. Rejected because today's evidence is that ANY contract gets violated; without a fallback, every violation cascades. Discipline + fallback beats discipline alone.
- **(b) Artifact handoff alone.** Sub-agent produces the artifact and substrate drives to terminal. Rejected because the substrate driver becomes a new failure surface (what if it crashes mid-drive?). Layering keeps the original sub-agent accountable AND has the substrate as floor.

### Q2 alternatives

- **(1) PR number as the only handle.** Cheapest. Rejected because 1/3 of today's failures were pre-PR (Task #311 sub-agent stalled before opening a PR). A handle that only covers PRs misses real failure cases.
- **(2) Plan-id as the handle.** Tightly couples this to the planning pipeline. Rejected because sub-agents dispatch for research, canon-scouting, audits — not just plans. The handle must generalize.

### Q3 alternatives

- **(a) Substrate-observed only (sub-agent never attests).** Purest enforcement. Rejected because it loses the audit signal of "agent thought it was done, here's what it checked" — that signal is gold for debugging future drift and for canon-grade learning. Enterprise systems want the rich audit, not just the gate.
- **(c) Sub-agent reports, no verification.** Just renames the current failure mode with a new atom type. Rejected as a non-fix.

### Q4 alternatives

- **(a) Fresh re-spawn only.** Cheapest. Rejected because it discards prior reasoning; the recovered agent has to re-learn everything the original one knew. Operator's "maximize work and effort and knowledge" framing argues for resume-first.
- **(b) Resume-by-default (no fresh fallback).** Rejected because resume can genuinely fail (blob shipped, model context overflow, stale beyond ttl). Without the fresh fallback, those cases escalate immediately on attempt #1, which violates "minimize errors."

### Q5 alternatives

- **(a) Uncapped per claim.** Solves "budget = never the failure cause" cleanly but is too sharp for indie (unbounded API bill) and unpredictable for org (one runaway claim chews 50-actor budget allocation).
- **(c) Adaptive budget tied to claim progress.** Smarter targeting but adds progress-signal definition + observer wiring. YAGNI vs (b) — only worth shipping if ladder proves insufficient.
- **(d) Budget by expected-terminal-state.** Sensible but requires claim-typing which isn't otherwise needed. Coupling claim-typing and budget would inflate the spec surface. Deferred to a future spec if observed-need emerges.

### Architecture-shape alternatives

- **Approach 1 — Vertical slice on pr-fix-actor.** Build the full system for one principal first. Rejected because it creates one-principal-shaped substrate code that's hard to generalize cleanly when the second principal adopts. Substrate-purity discipline argues for mechanism-first.
- **Approach 3 — Reaper-first quick-win.** Ship a minimal open-PR reaper as PR1 to address today's pain immediately. Rejected because the quick-win ships behavior we'd refactor in PR2; "ship the right fix the first time" argues against the false economy.

## 15. What breaks if revisited

Per `dev-forward-thinking-no-regrets`:

In 3 months at 10× scale (50+ actors, 10× more canon, more external integrations), the substrate is still sound:

- The `work-claim` atom generalizes — adding terraform-apply or slack-acked work-shapes is a new verifier file, not a substrate change.
- The reaper scales with `pol-claim-reaper-cadence-ms`; 15s cadence supports ~3,000 claims/min query throughput on the AtomStore (within current PR #197 race-fixed write throughput).
- The budget tier ladder is dial-by-canon; an org running 50 actors sets a single deployment-scoped policy atom and every actor inherits.
- The recovery layer composes cleanly with future actor types: every actor inherits the same dispatch contract, no per-actor recovery logic needed.

Regret modes:

- **If sub-agents become reliable on their own**, the reaper is mostly idle and the substrate is "insurance" we pay for in code complexity (~700 LOC). Acceptable; the insurance has historically been needed (3/3 today).
- **If a future failure mode emerges that the verifier handlers can't catch** (e.g., the GitHub API itself reports incorrect state), the substrate's audit-trail still surfaces the divergence — the system fails loudly to the operator rather than silently to wrong terminal state.
- **If budget tiers prove too coarse**, the adaptive-budget alternative (Q5c) can be added as a higher-priority canon-policy without changing substrate. The seam is preserved.

## 16. Acceptance criteria for PR1

A passing PR1 must:

- Add the `work-claim` atom type to `src/atoms/types.ts` with a new lifecycle-state union and JSDoc documenting the lifecycle.
- Provide `src/substrate/claim-contract.ts` with `dispatchSubAgent`, `markClaimComplete`, `ClaimHandle`, and the verifier-dispatch entry point. All exports are mechanism-only (no principal names, no work-shape hardcoding).
- Provide four reference verifier handlers under `src/substrate/claim-verifiers/`: `pr.ts`, `plan.ts`, `task.ts`, `research-atom.ts`, plus an `index.ts` registry.
- Provide `src/runtime/loop/claim-reaper.ts` with `runClaimReaperTick` and `recoverStalledClaim`. Not yet wired into LoopRunner; that's PR2.
- Provide `bootstrap/canon/pol-claim-budget-tier-{default,raised,max}.json`, `pol-claim-reaper-cadence-ms.json`, `pol-claim-recovery-max-attempts.json`, and `pol-claim-attesting-grace-ms.json`.
- Provide `bootstrap/bootstrap-claim-contract-canon.mjs` script that seeds the above atoms on a fresh deployment.
- 30+ tests in `test/substrate/claim-contract.test.ts` and `test/runtime/loop/claim-reaper.test.ts` covering: happy path, lifecycle transitions, attestation-rejection paths, all 4 verifier handlers (with mocked ground truth), budget-tier resolution, STOP integration at both `dispatchSubAgent` and `runClaimReaperTick`, concurrent-reaper claim-lock, recovery via resume and fresh, escalation at N=3.
- `npm run typecheck` and `npm run test` pass clean.
- Pre-push grep checklist (per `feedback_pre_push_grep_checklist`) shows no emdashes, no private terms, no design/ADR cross-refs in src/, no canon ids in src/.
- `node scripts/cr-precheck.mjs` reports 0 critical / 0 major findings before push.
- CR-clean after one round (target; up to 2 rounds acceptable).
- LAG-auditor + canon-compliance auditor sub-agent both approve.

## 17. Open questions / explicit future scope

- **Adaptive budget by progress signals (Q5c).** Defer until the ladder proves insufficient in practice; revisit after 30 days of substrate in production.
- **Per-claim STOP sentinel** (`.lag/STOP-CLAIM-<id>`). Defer until operator workflow demands granular stop; the existing global STOP covers safety today.
- **Claim-typing for budget-by-expected-terminal (Q5d).** Defer until ladder coverage gaps appear; the tier ladder is simpler and covers operator's stated need.
- **Multi-principal claim handoff.** Out of scope for this spec; a future spec covers cross-principal collaboration on the same work-item.
- **Console UI for the work-claim feed.** Follow-up PR after PR1+PR2 land; reads from AtomStore via existing `/api/atoms.find` endpoint with `type=work-claim` filter.
- **Reaper backend swap** (NOTIFY-driven vs polling). Future seam reserved; current polling is sufficient at indie + small-org scale. Org-ceiling deployments revisit when claim volume exceeds 1000/hour.

## References

### Canon directives applied

- `dev-sub-agent-pr-driver-responsibility` — the foundational discipline this substrate enforces mechanically.
- `dev-substrate-not-prescription` — substrate stays mechanism-only; policy in canon.
- `dev-indie-floor-org-ceiling` — every design choice serves both ends.
- `dev-governance-before-autonomy` — STOP sentinel + canon-policy first, automation dial second.
- `inv-l3-requires-human` — canon-policy edits (budget tier, recovery max, cadence) remain operator-signed.
- `inv-kill-switch-first` — STOP integration at every substrate entry point.
- `arch-atomstore-source-of-truth` — AtomStore is the single source of truth for claim state.
- `dev-extreme-rigor-and-research` — alternatives_rejected populated for every decision.
- `dev-forward-thinking-no-regrets` — Section 15 articulates 3-month review.

### Prior PRs informing this design

- PR #166 — Agent-loop substrate (4 seams + 2 atom types + 2 policies + projection).
- PR #170 — PrFixActor: the first actor with explicit observe → classify → propose → apply → reflect lifecycle that this substrate generalizes.
- PR #171 — ResumeAuthorAgentLoopAdapter: the substrate the recovery layer reuses.
- PR #172 — cr-precheck capability: the pre-push gate every PR honors.
- PR #197 — AtomStore.put TOCTOU race fix: the foundation the concurrent-reaper-lock relies on.
- PR #389 — pr-observation refresh canon-policy: the pattern the budget-tier policies follow.

### Substrate seams reserved

- Reaper backend (polling vs NOTIFY-driven).
- Verifier handler registry (open for extension).
- Notifier channel (operator-tunable).
