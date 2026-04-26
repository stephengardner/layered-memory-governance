# resume-author-agent-loop-adapter

## Purpose

A reference `AgentLoopAdapter` wrapper that resumes the original code-author session when an existing PR needs fixes, so the fix-time agent inherits the prior context (research, file reads, design rationale). On unrecoverable sessions (token cap, cleaned workspace, model-side context overflow, > N hours stale) it falls back to a fresh-spawn `ClaudeCodeAgentLoopAdapter`. Both attempts are logged via cross-referenced `agent-session` atoms.

## Signed by

The wrapper is a substrate-level adapter, not an Actor with its own principal. PRs it produces are signed by whichever bot identity the consuming Actor configures (in the autonomous flow, `lag-ceo` via `bootstrap-code-author-canon.mjs`). See `arch-bot-identity-per-actor`.

## Inbox / Outbox

- Inbox: an `AcquireInput` from the consuming Actor (e.g. PrFixActor) carrying the PR HEAD branch and the prior `agent-session` atom id reachable via `dispatched_session_atom_id` on the corresponding PR observation atom.
- Outbox: `agent-session` atoms (one per attempt), `agent-turn` atoms, plus the resume-or-fresh outcome atoms the consuming Actor emits downstream.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `arch-atomstore-source-of-truth`: every session record is an atom in the AtomStore.
- `arch-host-interface-boundary`: operates behind the `AgentLoopAdapter` substrate seam; external effects flow through `WorkspaceProvider` and `BlobStore`.
- `dev-flag-structural-concerns`: surfaces unresumable-session conditions explicitly rather than silently degrading.

## Source

`examples/agent-loops/resume-author/` on `main`.
