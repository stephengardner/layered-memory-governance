# Integration

Where to plug in your own code. Three seams, all opt-in, all canon-bounded.

## 1. Host adapters: stand up your own substrate backend

Implement the 8-interface `Host` contract (`AtomStore`, `CanonStore`, `LLM`, `Notifier`, `Scheduler`, `Auditor`, `PrincipalStore`, `Clock`). Run it through the conformance spec; if it passes, every governance primitive composes against it without code changes.

The shipped factories (`createMemoryHost`, `createFileHost`, `createBridgeHost`) are reference implementations.

## 2. Actors: outward-acting work under governance

`runActor` drives a loop of observe, classify, propose, apply, reflect with a kill-switch, budget, convergence guard, and per-action policy gating. Define your Actor and its `ActorAdapter`s; the Host stays the governance boundary; the Adapter handles external effects.

Reference Actors:

- `PrLandingActor`: drives a PR through review feedback to clean.
- `PlanningActor` plus host-LLM judgment: deliberates against L3 canon and produces Plan atoms.
- `AgenticCodeAuthorExecutor`: dispatches inbox code-author invocations into authored diffs.
- `PrFixActor`: picks up review feedback and lands fix commits under the bot identity.
- `ResumeAuthorAgentLoopAdapter`: lets a code-author session resume across ticks without losing context.

## 3. Capabilities: pluggable pre-action gates

Capabilities are first-class extension points around an Actor's apply step. The shipped `cr-precheck` capability runs the CodeRabbit CLI locally on the staged diff before any push, so the same review the required status check enforces is satisfied before the network round-trip. Pluggable per `dev-substrate-not-prescription`: drop in your own pre-push capability the same way (lint, typecheck, secret scan, signing-key check).

Wire a capability:

```ts
import { runActor } from 'layered-autonomous-governance/actors';

const actor = createMyActor({
  capabilities: ['cr-precheck', /* your-capability-here */],
});
```

## Identities

Pick PAT for solo dev, App-per-role for an autonomous org. Same Actor code; the auth client is the choice. See the README section on Actor identities.

## What you should not extend yet

- Multi-tenant scope bleed (deferred until single-tenant works).
- Cross-machine sync (V0 is single-machine).
- Hosted embedders (local ONNX is architecturally dominant for now).
