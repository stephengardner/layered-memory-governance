# cto-actor

## Purpose

The planning Actor: it observes intent and canon, proposes plans and canon refinements, and routes them for human or auto-approval. It does not mutate tracked files; tracked-file changes go through `code-author`.

## Signed by

Principal: `cto-actor`. See `arch-principal-hierarchy-signed-by` for the principal chain and `arch-bot-identity-per-actor` for the per-Actor App identity.

## Inbox / Outbox

- Inbox: `intent` atoms from the operator, `audit-finding` atoms, `actor-message` atoms from other Actors flagging structural concerns.
- Outbox: `plan` atoms, `canon-proposal` atoms, `actor-message` atoms dispatching work.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `pol-llm-tool-policy-cto-actor`: scoped tool surface, no tracked-file writes.
- `dev-canon-proposals-via-cto-not-direct`: canon edits originate as proposals from this Actor, not as direct writes.
- `dev-flag-structural-concerns`: halt and surface when verification fails.

## Source

`src/runtime/actors/planning/` on `main`.
