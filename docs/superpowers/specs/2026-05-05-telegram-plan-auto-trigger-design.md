# Telegram Plan Auto-Trigger -- Design Spec

**Date:** 2026-05-05
**Status:** Draft
**Closes gap:** Operator runs autonomous /loop sessions; new proposed plans accumulate in the AtomStore but no Telegram notification fires. The operator has to manually run `node scripts/plan-approve-telegram.mjs <plan-id>` or `plan-discuss-telegram.mjs <plan-id>` to be pinged. Operator flagged this 2026-05-05: "and am I supposed to ever be telegrammed or no" -- yes, but only manually today.

## Goal

Auto-fire a Telegram notification on every newly-proposed `plan` atom from an allowlisted principal (default: `cto-actor`, `cpo-actor`), exactly once per plan. Surface the plan summary + the operator-runnable discuss command on the operator's phone within minutes of the plan landing in `proposed` state, without polluting the chat with re-sends across ticks.

## Non-goals (v1)

- **Interactive long-poll session inside the tick.** The existing `plan-approve-telegram.mjs` and `plan-discuss-telegram.mjs` scripts spawn an interactive `getUpdates` loop that blocks waiting for the operator. The auto-trigger tick does NOT spawn that loop; it sends a one-shot notification and writes an idempotence record. The operator runs the discuss script manually when they want a Q+A session.
- **Inline-keyboard verdict capture.** Buttons on the auto-pushed message would require a long-running poller to handle taps; that poller is a separate concern from a tick. v1 ships the push only.
- **Multi-chat fan-out.** v1 sends to the single configured `TELEGRAM_CHAT_ID`. Multi-reviewer fan-out across multiple chats is org-ceiling and lands behind a follow-up policy atom.
- **Custom message templating.** Default message format covers the indie floor. Org-ceiling deployments register a higher-priority template via canon (deferred per `dev-future-proof-apex-tunable-trade-off-dials` -- populate dials only when a second use case arrives).

## Architecture

### Composition

```
LoopRunner.tick()
   ...
   ├── reaperPass            (PR #298)
   ├── planObservationRefreshPass  (PR #318)
   ├── planReconcilePass     (PR #318)
   └── planProposalNotifyPass  (THIS PR)
         │
         ├── runPlanProposalNotifyTick(host, notifier, options)
         │       ├── query proposed plans
         │       ├── filter by principal allowlist
         │       ├── filter by "no telegram-push-record exists yet"
         │       ├── for each: notifier.notify({ plan }) + write telegram-push-record
         │       └── return { scanned, notified, skipped: { reason: count } }
         │
         └── PlanProposalNotifier (pluggable seam, deployment-side adapter)
                 default impl in scripts/lib/telegram-plan-trigger.mjs
                 calls Telegram sendMessage API; no long-running poller
```

### Why a pluggable seam, not a baked-in Telegram call

`dev-framework-mechanism-only` says framework code stays mechanism-focused. The tick scans atoms and decides "this plan needs a notification"; the deployment adapter does the Telegram POST. This mirrors PR #318's `PrObservationRefresher`. Org-ceiling deployments swap the adapter (Slack, email, multi-chat) without the framework changing shape.

### Why an atom record, not a metadata field, for idempotence

A new `type: 'telegram-push-record'` atom with `provenance.derived_from: [planId]`, scope=`session`, layer=L0. Reasons:

1. **Atom immutability.** Atoms are signed, append-only records (per `arch-atomstore-source-of-truth`). Mutating `plan.metadata.telegram_pushed_at` after the fact would compromise the audit chain -- re-reading the plan tells you what the planner wrote, not what a downstream tick decided.
2. **Symmetry with reconcile.** `plan-merge-settled` (the reconcile pass marker) is a separate atom for the same reason.
3. **Queryability.** Operator asks "when was plan X pushed?" → `host.atoms.query({ type: ['telegram-push-record'] })` answers it.
4. **Decay-friendly.** A push-record half-life of 7 days means stale records age out without manual purge -- but during the lifetime of a `proposed` plan (reaper kills proposed plans at 72h by default), the record stays alive and idempotence holds.

### Allowlist as canon, not framework constant

Per `dev-framework-mechanism-only`: a hardcoded `['cto-actor', 'cpo-actor']` in `src/` would encode org-shape into framework primitives. Instead a canon policy atom `pol-telegram-plan-trigger-principals` carries the allowlist; the tick reads it on every pass (so a canon edit takes effect on the next tick without restart). Default-empty fallback: when no policy atom exists, the tick treats `cto-actor` and `cpo-actor` as the indie-floor default. (Empty-string allowlist explicitly disables the pass.)

Wait -- empty-string-disables vs default-allowlist. Re-reading `dev-substrate-not-prescription`: I'll go with **canon-policy-or-fallback-defaults**. When the canon atom is absent: defaults `['cto-actor', 'cpo-actor']` apply (indie zero-config). When the canon atom exists with an empty allowlist: pass is effectively disabled (org-ceiling explicit opt-out path). When the canon atom exists with a non-empty list: that list governs.

### Default cadence

Inherits the LoopRunner's `--interval` (default 60s). No separate poll loop. The tick is in-process, scans `~5000` atoms (bounded by `maxScan`), and sends Telegram messages via the deployment adapter -- typical cost ~1ms scan + 1 HTTP POST per new plan. Per-tick budget: `maxNotifies=5` to bound bursts under common per-chat rate limits (Telegram caps at ~30 msg/sec/chat overall but practical bursts are tighter); plans beyond the cap roll over to the next tick so overall throughput is bounded by tick-cadence x maxNotifies.

The operator's request "Indie-default cadence ~5min, env-overridable" matches the canon-tunable `pol-approval-cycle-tick-interval-ms` precedent (PR #283), but **the LoopRunner already runs at 60s and the auto-trigger pass piggybacks on that**. A separate "telegram tick interval" would be a configuration knob without a second use-case (`dev-future-proof-apex-tunable-trade-off-dials`: don't build dial infrastructure speculatively). The 60s default ticks 5x faster than the 5min freshness windows; this is fine for a notification surface.

## Components

### `src/runtime/plans/plan-trigger-telegram.ts` (new)

Pure tick function `runPlanProposalNotifyTick(host, notifier, options)`. Mechanism only: queries atoms, filters, calls the notifier, writes records. No Telegram I/O, no string parsing of plan IDs, no env reads.

```typescript
export interface PlanProposalNotifier {
  notify(args: {
    readonly plan: Atom;
    readonly summary: { readonly title: string; readonly body: string };
  }): Promise<void>;
}

export interface PlanProposalNotifyOptions {
  readonly now?: () => Time;
  readonly maxScan?: number;       // default 5000
  readonly maxNotifies?: number;   // default 20
  readonly principalAllowlistOverride?: ReadonlyArray<PrincipalId>;
}

export interface PlanProposalNotifyResult {
  readonly scanned: number;
  readonly notified: number;
  readonly skipped: Readonly<Record<string, number>>;
}

export async function runPlanProposalNotifyTick(
  host: Host,
  notifier: PlanProposalNotifier,
  notifyPrincipal: PrincipalId,
  options: PlanProposalNotifyOptions = {},
): Promise<PlanProposalNotifyResult>;
```

Skip reasons (histogram):
- `not-in-allowlist` -- plan principal not in resolved allowlist
- `already-pushed` -- telegram-push-record exists for this plan
- `tainted` / `superseded` -- defensive guards
- `notify-failed` -- adapter threw; counted, tick continues
- `rate-limited` -- exceeded `maxNotifies`

### `src/runtime/loop/telegram-plan-trigger-allowlist.ts` (new)

Tiny canon reader, mirrors `approval-cycle-interval.ts`:

```typescript
export const DEFAULT_PRINCIPAL_ALLOWLIST: ReadonlyArray<PrincipalId> = ['cto-actor', 'cpo-actor'] as PrincipalId[];

export async function readPlanTriggerAllowlist(host: Host): Promise<ReadonlyArray<PrincipalId>>;
```

Reads `metadata.policy.subject === 'telegram-plan-trigger-principals'` directive atoms. Returns `policy.principal_ids` array on hit, defaults on miss (or malformed).

### `src/runtime/loop/types.ts` (modify)

Add to `LoopOptions`:
- `runPlanProposalNotifyPass?: boolean` (default `false`)
- `planProposalNotifier?: PlanProposalNotifier`
- `planProposalNotifyPrincipal?: PrincipalId` (used as `principal_id` on the push-record audit atom)

Add to `LoopTickReport`:
- `planProposalNotifyReport: { scanned, notified, skipped } | null`

### `src/runtime/loop/runner.ts` (modify)

Add `planProposalNotifyPass()` private method. Pure delegate to `runPlanProposalNotifyTick` (matches `planObservationRefreshPass` pattern). Silent-skip when notifier seam is absent (once-per-runner warning, same latch pattern as `warnedMissingRefresher`). Order: runs AFTER reconcile (reconcile may abandon stale plans; we don't want to notify on a plan that just got auto-abandoned in the same tick).

### `src/cli/run-loop.ts` (modify)

Add CLI flags:
- `--notify-proposed-plans` (default ON)
- `--no-notify-proposed-plans`

Add to `RunLoopMainOptions`:
- `planProposalNotifierFactory?: () => Promise<PlanProposalNotifier | null> | PlanProposalNotifier | null;`

Plumb the factory the same way the `prObservationRefresherFactory` is plumbed: build the seam from the factory at boot, pass into `LoopRunner`.

### `bin/lag-run-loop.js` (modify)

Add a second factory:

```javascript
async function planProposalNotifierFactory() {
  // Dynamic-import scripts/lib/telegram-plan-trigger.mjs
  // and call createTelegramPlanProposalNotifier()
  // Returns null when env (TELEGRAM_BOT_TOKEN/CHAT_ID) is absent
  // -> the pass silent-skips per the LoopRunner contract.
}

const exitCode = await runLoopMain({
  prObservationRefresherFactory,
  planProposalNotifierFactory,
});
```

### `scripts/lib/telegram-plan-trigger.mjs` (new)

Deployment-side adapter. Mirrors `pr-observation-refresher.mjs`:

```javascript
export function validateNotifyArgs(args) { /* loud guards */ }

export function createTelegramPlanProposalNotifier(options = {}) {
  // Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from process.env.
  // Returns null if either is missing -> silent-skip path.
  // Returns { async notify({ plan, summary }) { ... } }
  //   POSTs to https://api.telegram.org/bot${token}/sendMessage with:
  //     - text: formatted message (title + body + plan ID + run-discuss command)
  //     - disable_web_page_preview: true
  //   Loud-fail on Telegram API error -> bubbles up to runPlanProposalNotifyTick
  //   which counts as skipped['notify-failed'].
}
```

The factory is the place that reads env vars; the LoopRunner stays env-agnostic.

### `scripts/lib/telegram-plan-trigger-format.mjs` (extracted -- pure formatter)

Per `dev-dry-extract-at-second-duplication`: the plan summary extraction (title from first markdown heading, rest as body) appears in `plan-approve-telegram.mjs` AND `plan-discuss-telegram.mjs` already; this is the third instance. Extract to a shared formatter that all three consumers import. Pure helper -- no I/O, fully unit-testable. The formatter exports `formatPlanForTelegram(plan)` returning `{ title, body, summary, message }`.

Wait -- actually looking at the existing code: `plan-approve-telegram.mjs` uses `formatPlanSummary` from `lib/plan-approve-telegram.mjs`, and `plan-discuss-telegram.mjs` has its own inline. Two existing instances + one new = three. Extract is mandatory. The shared module lives at `scripts/lib/plan-summary.mjs` and the existing two helpers re-export from it (zero behavior change).

## Idempotence Atom Schema

`type: 'telegram-push-record'`:

```typescript
{
  schema_version: 1,
  id: `telegram-push-${planId}-${nowIso}`,  // unique per plan; planId is enough for query
  content: 'plan pushed to telegram',
  type: 'telegram-push-record',
  layer: 'L0',
  provenance: {
    kind: 'agent-observed',
    source: { agent_id: notifyPrincipal, tool: 'plan-trigger-telegram' },
    derived_from: [planId],  // chain back to the plan
  },
  confidence: 1.0,
  created_at: nowIso,
  last_reinforced_at: nowIso,
  expires_at: null,
  scope: 'session',
  metadata: {
    plan_id: planId,
    pushed_at: nowIso,
    channel: 'telegram',
    chat_id_hash: <sha256 prefix of chat-id, NOT the chat-id itself>,
  },
  // ... standard atom defaults ...
}
```

The chat-id is hashed (first 16 hex of sha256) so the audit atom doesn't leak the chat-id into atoms that may be replicated/exported. The hash gives uniqueness for "did this chat receive this plan" queries without leaking the secret.

Wait -- that's overengineered for v1. The chat-id is in `.env`, never in tracked source, and hashing adds a dependency. Drop the field; the existence of the push-record under a deployment running with one chat-id IS the answer. Keep `metadata: { plan_id, pushed_at, channel: 'telegram' }`.

## Half-life Registration

`telegram-push-record` needs an entry in `DEFAULT_HALF_LIVES` to avoid the framework throwing on decay. Since the record is operational (not canonical fact), 7 days matches the existing `actor-message` / ephemeral floor. The reaper kills proposed plans at 72h by default; a 7-day half-life on the push-record handily outlasts the plan's proposed lifetime, so idempotence holds end-to-end.

## Test Plan

1. **Default off** -- `runPlanProposalNotifyPass=false` (default) → `planProposalNotifyReport === null`, notifier never called.
2. **Enabled, notifier missing** -- flag on, seam absent → silent-skip + once-per-runner warning across N ticks (mirrors PR #318 latch pattern).
3. **Enabled, notifier present, new proposed plan from cto-actor** -- notifier called once with the plan + summary, push-record atom written.
4. **Enabled, idempotence** -- re-tick same state → notifier NOT called second time (push-record query short-circuits).
5. **Plan principal NOT in allowlist** (e.g. `code-author`) → skipped with `not-in-allowlist`.
6. **Plan in non-proposed state** (e.g. `executing`) → skipped (filtered out by `plan_state=['proposed']` query filter).
7. **Notifier throws** -- counted as `skipped['notify-failed']`, tick continues, push-record NOT written (so next tick retries -- this is the desired behavior since the push didn't actually land).
8. **Allowlist read from canon policy atom** -- canon override `['cto-actor']` (cpo dropped) → cpo plan skipped, cto plan notified.
9. **Best-effort: tick failure does NOT fail the loop** -- synthetic injected failure on `host.atoms.put` for telegram-push-record → error logged, tick report `planProposalNotifyReport === null`, other passes continue.
10. **Per-tick rate limit** -- N+1 plans, `maxNotifies=N` → first N notified, +1 counted as `rate-limited`.
11. **Pure formatter unit tests** -- `scripts/lib/plan-summary.mjs` exports `formatPlanForTelegram(plan)` with title-from-first-heading + body-rest contract.

## Observability

Per-tick stdout from `formatTickReport` gains a `notify(notified=N)` segment when the pass actually ran. Audit log row `loop.tick` carries `plan_proposal_notify_scanned` + `plan_proposal_notify_notified`.

## Indie-floor / Org-ceiling fit

| Posture | Behavior |
|---|---|
| Solo dev with `.env` set | Default ON, default cadence, default allowlist (cto+cpo). Zero config. Phone pings within ~60s of new proposed plan. |
| Solo dev without `.env` | Factory returns null → silent-skip. No errors, no warnings beyond the once-per-runner gap log. |
| Org with single chat | Same as solo. |
| Org with custom allowlist | `pol-telegram-plan-trigger-principals` canon atom enumerates allowed principals. |
| Org with custom channel (Slack/email) | BYO `PlanProposalNotifier` adapter; the factory returns it instead of the Telegram one. Framework code unchanged. |
| Org with multi-chat fan-out | Adapter wraps multiple chat sends inside one `notify()` call, OR a future v2 widens the seam to return per-chat results. v1 doesn't preempt either path. |

## Risks & Trade-offs

- **What if the operator ALREADY had a manual `plan-discuss-telegram` session running on the same plan?** Two messages land. Acceptable for v1 -- the manual session is operator-initiated and the auto-push is informative; both are useful surfaces.
- **What if Telegram rate-limits?** The notifier-throw path counts as `notify-failed`, push-record NOT written, retry next tick. Telegram's 30 msg/sec/chat limit comfortably exceeds the per-tick `maxNotifies=20` cap.
- **What if the operator wants to silence the auto-trigger temporarily?** `--no-notify-proposed-plans` flag at boot disables. For a finer-grained pause, the operator can drop a STOP sentinel which the LoopRunner already honors; the auto-trigger pass inherits that behavior because it runs inside the tick.
- **Citation-verification:** the prose of the auto-pushed message MUST be limited to fields read from the plan atom (title, body, id). No fabricated paths or atom-ids -- the push is mechanical extraction.

## Future-proofing

- **Apex-tunable dials seam preserved:** the policy-atom-driven allowlist + per-tick options struct + pluggable notifier seam mean future dials (severity threshold, blast-radius gate, multi-channel fan-out) land as canon atoms or adapter additions, not framework changes.
- **Chat-id rotation:** hashed audit metadata was considered and rejected as YAGNI. If the operator rotates `TELEGRAM_CHAT_ID` and wants to know "which chat did plan X land in", they have the deployment's audit log -- out of band from the atom store.
- **Approval-cycle interaction:** the auto-trigger fires on `proposed` state. Approval-cycle ticks transition `executing → succeeded/abandoned`. They're orthogonal -- neither pass interferes with the other.

## Substrate purity audit

| Rule | Compliance |
|---|---|
| `dev-framework-mechanism-only` | tick mechanism in `src/runtime/plans/`; concrete Telegram POST in `scripts/lib/`; allowlist in canon |
| `dev-indie-floor-org-ceiling` | solo zero-config; org swaps adapter / canon allowlist |
| `arch-atomstore-source-of-truth` | atom-record idempotence, no in-place mutation |
| `dev-dry-extract-at-second-duplication` | plan-summary formatter extracted (third call site) |
| `dev-future-proof-apex-tunable-trade-off-dials` | seam preserved; no speculative dial infrastructure |
| `dev-substrate-not-prescription` | allowlist + cadence are canon, not code |
| `inv-kill-switch-first` | tick honors STOP sentinel via LoopRunner's existing kill check |

## Citations (verified against worktree HEAD = 870fb98)

- PR #318 precedent: `src/runtime/loop/runner.ts:381-432` (refresh + reconcile pass wiring)
- PR #318 silent-skip latch: `src/runtime/loop/runner.ts:114-129, 389-414` (`warnedMissingRefresher`)
- LoopOptions shape: `src/runtime/loop/types.ts:99-237`
- LoopTickReport shape: `src/runtime/loop/types.ts:262-334`
- PR-observation refresh tick (mechanism precedent): `src/runtime/plans/pr-observation-refresh.ts:151-253`
- Canon reader pattern: `src/runtime/loop/approval-cycle-interval.ts:35-57`
- Deployment-side adapter pattern: `scripts/lib/pr-observation-refresher.mjs:71-93`
- Bin composition root: `bin/lag-run-loop.js:31-57`
- Existing telegram message format: `scripts/plan-approve-telegram.mjs:179-188` (event shape)
- Existing telegram inline-poll loop (illustrating why we DON'T spawn this in a tick): `scripts/plan-discuss-telegram.mjs:160-206`
- Plan atom on disk (verified shape): `.lag/atoms/plan-add-running-idle-freshness-badge-to-lag--cto-actor-pipeline-cto-1778014171407-1czl60-0.json`
- `plan_state` filter on AtomFilter: `src/substrate/types.ts:362-363`
- Reaper TTLs (proposed plan lifetime): `src/runtime/plans/reaper.ts:274-289`
