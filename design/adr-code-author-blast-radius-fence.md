# ADR: Code-author blast-radius fence (reservation, not implementation)

**Status:** RESERVED. Not yet implementable.
**Source plan:** `plan-harden-three-substrate-layers-before-aut-cto-actor-20260420171042`
**Authored:** 2026-04-20, by the cto-actor self-audit run.
**Decision:** reserve the `pol-code-author-*` policy atom slot and fence design; do NOT seed atoms or write fence code until the code-author principal's bootstrap ADR lands.

## Why reserve (and why not implement now)

The CTO's self-audit identified three hardening asks before autonomous code-gen ships. The third was a blast-radius fence for a future code-author actor: a principal that can write to `src/` on operator behalf. Today that principal does not exist. The self-audit's own devil's-advocate partially conceded the point:

> "Writing `pol-code-author-*` atoms for a principal that has no bootstrap script risks canon drift - atoms that decay because their subject never materializes."

So: reserve the slot and freeze the shape. Seed atoms only when the principal is real.

## The four fence atoms (spec, not yet seeded)

When `bootstrap-code-author-canon.mjs` ships, it seeds these four policy atoms. The shapes are frozen here so the future bootstrap is a mechanical operation, not a design call.

### 1. `pol-code-author-signed-pr-only`

**Enforces:** no direct writes to `src/`, `test/`, `design/`, `docs/`, `scripts/`, or any other tracked path. All changes land through a signed pull request authored by the code-author principal via its provisioned GitHub App identity.

```json
metadata.policy: {
  subject: 'code-author-authorship',
  output_channel: 'signed-pr',            // literal; alternatives rejected
  allowed_direct_write_paths: [],         // empty = no direct writes
  require_app_identity: true,             // signed commits via App, not PAT
}
```

**Rationale:** the operator reviews a PR diff. A direct `src/` write bypasses that review and the branch-protection gate. Every mutation has to be visible in GitHub's review UI.

### 2. `pol-code-author-per-pr-cost-cap`

**Enforces:** a hard cap on LLM spend per PR, independent of the per-day budget. A single runaway plan must trip before it eats the whole day.

```json
metadata.policy: {
  subject: 'code-author-per-pr-cost-cap',
  max_usd_per_pr: <number>,               // seeded at 10.0 for v0
  include_retries: true,                  // retries count toward the cap
}
```

**Rationale:** `pol-inbox-poll-cadence` + `pol-actor-message-rate` cap per-minute and per-day. Neither catches a single plan that plans→codes→re-plans→codes in a single logical PR until it has burned $50 of budget. The per-PR cap is the missing axis.

### 3. `pol-code-author-ci-gate`

**Enforces:** a PR from the code-author actor is only eligible for any auto-approval (PR-landing merge, plan-dispatch of a follow-up plan, etc.) after CI reports `SUCCESS` for Node 22 Linux, Node 22 Windows, and `package-hygiene`.

```json
metadata.policy: {
  subject: 'code-author-ci-gate',
  required_checks: [
    'Node 22 on ubuntu-latest',
    'Node 22 on windows-latest',
    'package hygiene',
  ],
  // CodeRabbit pass is a separate gate per existing policy; this atom
  // only covers the CI-correctness floor.
  require_all: true,
  // Stale check results (older than max_check_age_ms) are not
  // honored. Prevents a 3-week-old green check from justifying an
  // auto-merge on a freshly-edited branch.
  max_check_age_ms: 600_000,              // 10 minutes
}
```

**Rationale:** a plan cannot be "approved" before its CI story is in; a downstream dispatcher cannot chain off a code-author PR that hasn't proven it builds.

### 4. `pol-code-author-write-revocation-on-stop`

**Enforces:** when `.lag/STOP` is written during a code-author run, the actor: (a) halts its current operation, (b) closes (not abandons) any in-progress draft PR with a comment explaining the revocation, and (c) writes a `code-author-revoked` atom so the operator can resume or discard explicitly.

```json
metadata.policy: {
  subject: 'code-author-write-revocation',
  on_stop_action: 'close-pr-with-revocation-comment',
  draft_atoms_layer: 'L0',                // revocation preserves drafts for re-entry
  revocation_atom_type: 'code-author-revoked',
}
```

**Rationale:** `inv-kill-switch-first` says STOP halts everything. For a code-author, "halt" has to mean more than just "stop the loop" - the in-flight PR needs explicit revocation so the operator finds a clean state, not a half-drafted PR sitting open.

## Graduation criteria (when to un-reserve this ADR)

All must hold before seeding the atoms above:

1. **Principal `code-author` exists** in `.lag/principals/`, signed_by a parent principal (typically `claude-agent` or equivalent).
2. **Medium-tier kill switch (D13)** has shipped. The STOP sentinel today is a soft halt - sufficient for actors that only write atoms, not for an actor that pushes commits. Medium-tier must exist before the fence is the LAST line of defense.
3. **`test/arbitration/conflict-fuzz.ts`** is green on the Postgres Host (per the CTO's hardening ask #2). A code-author whose plans race against an unfuzzed arbitration layer is a source-of-truth risk the HIL cannot see.
4. **The judgment-fallback-ladder (`pol-judgment-fallback-ladder`)** is in force. A code-author cannot ship on a judgment layer where a failed draft can auto-approve.

## What explicitly NOT to do now

- **Do NOT seed** `pol-code-author-*` atoms. They would decay because the principal they gate does not exist, and decay would look like an operator choice in arbitration.
- **Do NOT write** a `code-author-actor.ts` module until graduation criteria are met.
- **Do NOT** bundle this ADR's implementation into another PR. It must be its own review pass so the operator sees the full authority grant in isolation.

## Provenance

- `plan-harden-three-substrate-layers-before-aut-cto-actor-20260420171042` - source self-audit plan.
- `inv-kill-switch-first` - fence rule #4 directly implements the invariant for the code-author case.
- `inv-governance-before-autonomy` - fence #3 (CI gate) is the governance-before-autonomy surface for code-gen.
- `inv-l3-requires-human` - fence #1 (signed-PR-only) keeps the human review path load-bearing.
- `pol-cto-no-merge` - fence #2 (per-PR cost cap) extends the existing no-merge posture with spend bounds.
- `dev-substrate-not-prescription` - fences are policy atoms, not framework constants; operators tune via canon edit.
- `dev-no-hacks-without-approval` - revocation rule (#4) prevents silent half-drafted PRs from becoming hacky workarounds.
- `dev-forward-thinking-no-regrets` - reserving the slot now means graduation is a canon edit, not a re-design.

## Decision record

| Date | Actor | Action |
|---|---|---|
| 2026-04-20 | cto-actor (self-audit run) | Proposed as hardening ask #3 in the self-audit plan. |
| 2026-04-20 | cto-actor (devil's-advocate of same plan) | Conceded deferral: reserve ADR slot, do not seed atoms yet. |
| 2026-04-20 | operator / maintainer | Under review: ADR-only PR proposes freezing the four-atom shape; merge pending. |
| (pending) | future bootstrap author | Seeds `pol-code-author-*` once graduation criteria are met. |
| (pending) | future operator | Reviews + merges the first code-author PR that ships under these fences. |
