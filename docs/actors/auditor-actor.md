# auditor-actor

> Status: **roadmap**. The `auditor-actor` principal exists in `.lag/principals/auditor-actor.json` and is reserved for a read-only review Actor, but a runtime implementation has not yet shipped. There is no `src/runtime/actors/auditor/` module on `main`. The audit *function* described below currently runs as a sub-agent of the implementer per `dev-implementation-canon-audit-loop`, not as a standalone Actor.

## Intended purpose

The read-only Actor that reviews diffs, plans, and canon proposals against the L3 canon catalogue. It would produce findings; it would never write tracked files. It is reserved as the v0 read-only allowlist member for plan auto-approval.

## Signed by (when shipped)

Principal: `auditor-actor`, signed_by `apex-agent`. See `arch-principal-hierarchy-signed-by`. Bot identity per `arch-bot-identity-per-actor` will be assigned when the runtime Actor lands.

## Inbox / Outbox (when shipped)

- Inbox: `plan` atoms, diffs from `code-author` runs, `canon-proposal` atoms.
- Outbox: `audit-finding` atoms, `actor-message` atoms returning verdicts.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `pol-plan-auto-approve-low-stakes`: auditor is reserved as the v0 read-only allowlist member.
- `dev-actor-scoped-llm-tool-policy`: read-only tool posture; the per-principal `pol-llm-tool-policy-auditor-actor` policy atom is not yet authored, and the deny-all fallback applies until it is.
- `dev-implementation-canon-audit-loop`: the per-task canon-compliance audit pass runs before any commit. Today this runs as a sub-agent of the implementer; the standalone Actor will externalize it.
- `dev-flag-structural-concerns`: halt and surface when a citation cannot be verified.

## Source

Not yet implemented. The roadmap path is `src/runtime/actors/auditor/`. The lag-auditor CI job is currently scaffolded as a no-op gate via the planning trail in `plan-add-lag-auditor-noop-job-to-github-workf-cto-actor-20260424231351`.
