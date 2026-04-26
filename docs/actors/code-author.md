# code-author

## Purpose

The only Actor permitted to mutate tracked files in the repository. It receives plan atoms, drafts a unified diff, opens a signed pull request against `main`, and exits. Other Actors that need code changes route through it.

## Signed by

Principal: `code-author`. The `signed_by` chain is rooted at the operator key and projects onto a per-Actor GitHub App identity, never the operator's personal account. See `arch-principal-hierarchy-signed-by` and `arch-bot-identity-per-actor`.

## Inbox / Outbox

- Inbox: `plan` atoms (executing plans with target paths and success criteria), and `actor-message` atoms requesting code changes.
- Outbox: `pull-request` atoms (links to the opened PR), `actor-message` atoms acknowledging or refusing the request, and `audit-finding` atoms when the audit halts the write.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `pol-code-author-signed-pr-only`: every tracked-file mutation ships as a signed PR opened by this Actor.
- `pol-llm-tool-policy-code-author`: tool surface is scoped; no direct write outside the diff.
- `pol-code-author-write-revocation-on-stop`: write capability is revoked on stop.
- `pol-code-author-ci-gate`: CI must be green before merge is permitted.
- `pol-code-author-per-pr-cost-cap`: per-PR USD cost is bounded by the fence.
- `dev-coderabbit-required-status-check-non-negotiable`, `dev-coderabbit-cli-pre-push`: CodeRabbit gates merge and runs locally pre-push.
- `dev-implementation-canon-audit-loop`: the audit subagent reviews the diff against canon before commit.

## Source

`src/runtime/actors/code-author/` on `main`.
