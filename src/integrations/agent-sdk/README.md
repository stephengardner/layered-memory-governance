# Agent SDK integration

Reference integration that drives the substrate deliberation pattern
over Anthropic's Messages API. Thin wrapper only; every substrate
boundary (atom store, principal store, kill switch, canon renderer)
stays on the other side of a callback seam so a different runtime
(LangGraph, Letta, AutoGen, a plain HTTP loop) can plug in without
modifying the coordinator.

## Surface

```ts
import { startAgent, deliberate } from '<this path>';
```

- `startAgent(opts)` returns an `AgentHandle` bound to one principal.
  The handle exposes `respondTo(question)` and
  `counterOnce(positions)`, which call the Messages API and return
  deliberation patterns (`Position`, `Counter`).
- `deliberate(opts)` walks the Question -> Positions -> Counters ->
  Decision | Escalation chain across a map of AgentHandles, driven by
  the substrate arbitrator and escalation emitter.

## Seams (what this integration does NOT own)

- **AtomStore**: Both `startAgent` (for reasoning blocks) and
  `deliberate` (for Question/Position/Counter/Decision/Escalation)
  accept callback sinks. The caller translates pattern shapes into
  core `Atom`s and persists via its own `AtomStore.put`. This keeps
  the integration pattern-layer only, matching the discipline in
  `src/substrate/deliberation/`.
- **Canon**: The caller supplies an object that satisfies
  `CanonRendererForPrincipal`. The substrate `CanonMdManager.renderFor`
  is the reference implementation but any compatible function works.
- **Kill switch**: The caller passes an `AbortSignal`. The substrate
  `createKillSwitch` returns one directly; a plain
  `AbortController.signal` also works. No direct dependency on
  `KillSwitchController` shape.
- **Anthropic client**: Typed structurally as `MessagesClient`. Pass
  `new Anthropic()` in production and a `vi.fn` mock in tests. No
  import of the concrete SDK type leaks through the public API.

## Extended thinking

`respondTo` enables `thinking: { type: 'enabled', budget_tokens }` on
the Messages call. Any `thinking` content blocks returned by the API
are forwarded to an optional `reasoningSink` callback, so callers can
persist the plaintext chain-of-thought as atoms. This is the
substrate advantage over opaque CLI runtimes: reasoning stays
first-class.

## Response contract

`respondTo` expects the model to reply with a single JSON object:

```
{ "answer": string, "rationale": string, "derivedFrom": string[] }
```

`counterOnce` expects either:

```
{ "counter": null }
```

or:

```
{
  "targetPositionId": string,
  "objection": string,
  "derivedFrom": string[]
}
```

Both parsers tolerate markdown code fences around the JSON object.
Invalid JSON surfaces as an exception so the coordinator can fail the
round loudly rather than silently drop a participant.

## Related

- Deliberation patterns and arbitrator:
  `src/substrate/deliberation/`.
- Host interface the substrate stores implement:
  `src/substrate/interface.ts`.
- Substrate kill switch producing the AbortSignal:
  `src/substrate/kill-switch/`.
